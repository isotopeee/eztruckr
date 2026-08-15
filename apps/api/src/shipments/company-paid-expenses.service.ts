import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  ShipmentStatus,
  type CompanyPaidExpense,
  type CreateCompanyPaidExpenseInput,
  type UpdateCompanyPaidExpenseInput,
} from '@eztruckr/types';
import { resolvePayeeRequirement } from '../master-data/payee-requirement';
import { auditFields } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * Costs the company settled itself, so they never reached a liquidation.
 *
 * ITS OWN SERVICE, AND THE REASON IS THE LOCK. `ShipmentChargesService` looks
 * like the natural home — same shape, same shipment, same category lookup —
 * but every write there goes through `assertChargesEditable`, which refuses
 * once a commission has been PAID. That guard is correct for a charge, because
 * a charge feeds the commission base and a paid commission names a figure that
 * has to keep reconciling.
 *
 * A company-paid expense feeds no commission at all. It is a cost of the trip
 * and nothing downstream of it is anybody's pay, so the only thing that should
 * stop the record being corrected is the trip being CLOSED — the same argument
 * that keeps truck assignment out of `assignCrew`. Sharing a class with the
 * charges would put the two guards one method apart and make the looser one
 * look like an oversight; the next person to "make it consistent" would
 * silently forbid recording a fuel invoice that arrived after payday.
 */
@Injectable()
export class CompanyPaidExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  private get expenses() {
    return this.prisma.client.companyPaidExpense;
  }

  async list(shipmentId: string): Promise<CompanyPaidExpense[]> {
    await this.shipments.load(shipmentId);

    const rows = await this.expenses.findMany({
      where: { shipmentId },
      include: EXPENSE_INCLUDE,
      orderBy: [{ spentAt: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toCompanyPaidExpense);
  }

  async add(shipmentId: string, input: CreateCompanyPaidExpenseInput): Promise<CompanyPaidExpense> {
    await this.assertEditable(shipmentId);
    await this.assertPayeeExists(input.payeeId);
    await this.assertReceiptExists(input.receiptId);

    // Also the category's existence check — see `resolvePayeeRequirement`.
    const payeeRequired = await resolvePayeeRequirement(
      this.prisma.client.expenseCategory,
      input.expenseCategoryId,
      input.payeeId,
    );

    const row = await this.expenses.create({
      data: {
        shipmentId,
        expenseCategoryId: input.expenseCategoryId,
        description: input.description,
        amount: input.amount,
        spentAt: new Date(input.spentAt),
        payeeId: input.payeeId,
        payeeRequired,
        referenceNumber: input.referenceNumber,
        receiptId: input.receiptId,
      },
      include: EXPENSE_INCLUDE,
    });

    return toCompanyPaidExpense(row);
  }

  async update(
    shipmentId: string,
    id: string,
    input: UpdateCompanyPaidExpenseInput,
  ): Promise<CompanyPaidExpense> {
    await this.assertEditable(shipmentId);
    await this.assertBelongs(shipmentId, id);
    await this.assertPayeeExists(input.payeeId);
    await this.assertReceiptExists(input.receiptId);

    // Both halves of the rule are re-resolved against what the row will look
    // like AFTER the patch, not what was sent. A PATCH that changes only the
    // category can make a previously legal row illegal, and one that only
    // clears the payee is the same failure from the other side; validating the
    // request alone would miss both.
    const payeeRequired = await this.resolveRequirementAfterPatch(id, input);

    const row = await this.expenses.update({
      where: { id },
      data: {
        ...(input.expenseCategoryId === undefined
          ? {}
          : { expenseCategoryId: input.expenseCategoryId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.spentAt === undefined ? {} : { spentAt: new Date(input.spentAt) }),
        ...(input.payeeId === undefined ? {} : { payeeId: input.payeeId }),
        ...(input.referenceNumber === undefined ? {} : { referenceNumber: input.referenceNumber }),
        ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        // Re-stamped: the row's frozen rule follows its category.
        payeeRequired,
      },
      include: EXPENSE_INCLUDE,
    });

    return toCompanyPaidExpense(row);
  }

  async remove(shipmentId: string, id: string): Promise<{ removed: true }> {
    await this.assertEditable(shipmentId);
    await this.assertBelongs(shipmentId, id);

    await this.expenses.softDelete({ id });

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * Editable until the trip closes. See the class docblock for why this is not
   * `assertChargesEditable`.
   */
  private async assertEditable(shipmentId: string): Promise<void> {
    const shipment = await this.shipments.load(shipmentId);

    if (this.shipments.statusOf(shipment) === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is closed; its costs are now part of the record.`,
      );
    }
  }

  /**
   * Checked against the shipment in the path, not just against the table.
   * Without it, `DELETE /shipments/A/company-expenses/{id-belonging-to-B}`
   * would edit another trip's costs while passing A's editability check.
   */
  private async assertBelongs(shipmentId: string, id: string): Promise<void> {
    const found = await this.expenses.findFirst({
      where: { id, shipmentId },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException(`No company-paid expense ${id} on shipment ${shipmentId}`);
    }
  }

  /**
   * The category rule applied to the row as the patch will leave it.
   *
   * `undefined` means "this PATCH did not mention the field", so the current
   * value stands; an explicit `null` payee means "clear it", which the rule may
   * refuse.
   */
  private async resolveRequirementAfterPatch(
    id: string,
    input: UpdateCompanyPaidExpenseInput,
  ): Promise<boolean> {
    const current = await this.expenses.findFirst({
      where: { id },
      select: { expenseCategoryId: true, payeeId: true },
    });

    if (!current) {
      throw new NotFoundException(`No company-paid expense with id ${id}`);
    }

    return resolvePayeeRequirement(
      this.prisma.client.expenseCategory,
      input.expenseCategoryId ?? current.expenseCategoryId,
      input.payeeId === undefined ? current.payeeId : input.payeeId,
    );
  }

  /**
   * Existence only, deliberately — not `isActive`, matching every other
   * reference check in the system. A deactivated payee is one no longer
   * OFFERED for new work, and refusing it here would block correcting an
   * expense whose vendor has since been retired.
   *
   * Absence is not this function's business either way: `null` is an expense
   * with no payee and `undefined` is a PATCH that did not mention one. Whether
   * absence is ALLOWED is `resolvePayeeRequirement`'s question, asked against
   * the expense category — checking it here as well would put half the rule in
   * two places.
   */
  private async assertPayeeExists(payeeId: string | null | undefined): Promise<void> {
    if (!payeeId) return;

    const found = await this.prisma.client.payee.findFirst({
      where: { id: payeeId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest('payeeId', `No payee with id ${payeeId}`);
    }
  }

  private async assertReceiptExists(receiptId: string | null | undefined): Promise<void> {
    if (!receiptId) return;

    const found = await this.prisma.client.receipt.findFirst({
      where: { id: receiptId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest('receiptId', `No receipt with id ${receiptId}`);
    }
  }
}

const EXPENSE_INCLUDE = {
  expenseCategory: { select: { name: true } },
  payee: { select: { name: true } },
  receipt: { select: { fileName: true } },
} satisfies Prisma.CompanyPaidExpenseInclude;

type ExpenseRow = Prisma.CompanyPaidExpenseGetPayload<{ include: typeof EXPENSE_INCLUDE }>;

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}

function toCompanyPaidExpense(row: ExpenseRow): CompanyPaidExpense {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    expenseCategoryId: row.expenseCategoryId,
    expenseCategoryName: row.expenseCategory?.name ?? null,
    description: row.description,
    amount: row.amount.toString(),
    spentAt: row.spentAt.toISOString(),
    payeeId: row.payeeId,
    payeeName: row.payee?.name ?? null,
    payeeRequired: row.payeeRequired,
    referenceNumber: row.referenceNumber,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    ...auditFields(row),
  };
}
