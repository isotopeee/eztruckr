import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  AdditionalCharge,
  BillableExpense,
  CreateAdditionalChargeInput,
  CreateBillableExpenseInput,
  UpdateAdditionalChargeInput,
  UpdateBillableExpenseInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { auditFields } from '../master-data/serialize';
import { resolvePayeeRequirement } from '../master-data/payee-requirement';
import { ShipmentsService } from './shipments.service';

/**
 * The two kinds of money a shipment picks up beyond its freight rate.
 *
 * They are separate tables because they are separate things, and the
 * difference matters to the P&L rather than to the UI:
 *
 *   A BILLABLE EXPENSE is a cost the company fronted and recovers — a permit,
 *   a crane, port charges. It appears on both sides: revenue when billed, cost
 *   when incurred.
 *
 *   An ADDITIONAL CHARGE is a fee with no underlying cost — an extra drop,
 *   detention, a fuel surcharge. Pure revenue.
 *
 * Both carry `isCommissionable`, and that flag is the only thing deciding
 * whether the crew share in them. Defaulting it to false is deliberate: an
 * unflagged charge costs the company nothing extra, whereas a wrongly flagged
 * one silently inflates every commission on the trip.
 *
 * A BILLABLE EXPENSE NOW CARRIES WHAT A COMPANY-PAID ONE DOES — a date, a
 * payee with its frozen requirement, a reference and a receipt. The two are the
 * same act of spending recorded from opposite sides, and this one asking fewer
 * questions was an accident of which was written first, not a rule. The payee
 * requirement is resolved through the same `resolvePayeeRequirement` and backed
 * by the same shape of CHECK, so the three disbursement tables refuse the same
 * rows rather than each being trusted separately.
 *
 * Every write here goes through `assertChargesEditable`, so a charge can never
 * be added behind a commission that has already been computed against a base
 * that did not include it.
 */
@Injectable()
export class ShipmentChargesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  // --- billable expenses ---------------------------------------------------

  async listBillableExpenses(shipmentId: string): Promise<BillableExpense[]> {
    await this.shipments.load(shipmentId);

    const rows = await this.prisma.client.billableExpense.findMany({
      where: { shipmentId },
      include: BILLABLE_INCLUDE,
      orderBy: [{ spentAt: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toBillableExpense);
  }

  async addBillableExpense(
    shipmentId: string,
    input: CreateBillableExpenseInput,
  ): Promise<BillableExpense> {
    await this.shipments.assertChargesEditable(shipmentId);
    await this.assertCategoryExists(input.expenseCategoryId);
    await this.assertPayeeExists(input.payeeId);
    await this.assertReceiptExists(input.receiptId);
    await this.assertLiquidationOnShipment(shipmentId, input.liquidationId);

    const row = await this.prisma.client.billableExpense.create({
      data: {
        shipmentId,
        expenseCategoryId: input.expenseCategoryId,
        description: input.description,
        amount: input.amount,
        spentAt: new Date(input.spentAt),
        isCommissionable: input.isCommissionable,
        payeeId: input.payeeId,
        liquidationId: input.liquidationId,
        payeeRequired: await this.freezePayeeRule(input.expenseCategoryId, input.payeeId),
        referenceNumber: input.referenceNumber,
        receiptId: input.receiptId,
      },
      include: BILLABLE_INCLUDE,
    });

    return toBillableExpense(row);
  }

  async updateBillableExpense(
    shipmentId: string,
    id: string,
    input: UpdateBillableExpenseInput,
  ): Promise<BillableExpense> {
    await this.shipments.assertChargesEditable(shipmentId);
    await this.assertBillableExpenseExists(shipmentId, id);
    await this.assertCategoryExists(input.expenseCategoryId);
    await this.assertPayeeExists(input.payeeId);
    await this.assertReceiptExists(input.receiptId);
    await this.assertLiquidationOnShipment(shipmentId, input.liquidationId);

    // Resolved against the row as the patch will leave it, not against the
    // request: changing only the category, or clearing only the payee, are the
    // same failure approached from opposite sides.
    const payeeRequired = await this.resolveRequirementAfterPatch(id, input);

    const row = await this.prisma.client.billableExpense.update({
      where: { id },
      data: {
        ...(input.expenseCategoryId === undefined
          ? {}
          : { expenseCategoryId: input.expenseCategoryId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.spentAt === undefined ? {} : { spentAt: new Date(input.spentAt) }),
        ...(input.isCommissionable === undefined
          ? {}
          : { isCommissionable: input.isCommissionable }),
        ...(input.payeeId === undefined ? {} : { payeeId: input.payeeId }),
        // `undefined` leaves the link alone; an explicit null moves the cost
        // back onto this row, which is a real edit and not a no-op.
        ...(input.liquidationId === undefined ? {} : { liquidationId: input.liquidationId }),
        ...(input.referenceNumber === undefined ? {} : { referenceNumber: input.referenceNumber }),
        ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        // Re-stamped: the row's frozen rule follows its category.
        payeeRequired,
      },
      include: BILLABLE_INCLUDE,
    });

    return toBillableExpense(row);
  }

  async removeBillableExpense(shipmentId: string, id: string): Promise<{ removed: true }> {
    await this.shipments.assertChargesEditable(shipmentId);
    await this.assertBillableExpenseExists(shipmentId, id);

    await this.prisma.client.billableExpense.softDelete({ id });

    return { removed: true };
  }

  // --- additional charges --------------------------------------------------

  async listAdditionalCharges(shipmentId: string): Promise<AdditionalCharge[]> {
    await this.shipments.load(shipmentId);

    const rows = await this.prisma.client.additionalCharge.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toAdditionalCharge);
  }

  async addAdditionalCharge(
    shipmentId: string,
    input: CreateAdditionalChargeInput,
  ): Promise<AdditionalCharge> {
    await this.shipments.assertChargesEditable(shipmentId);

    const row = await this.prisma.client.additionalCharge.create({
      data: {
        shipmentId,
        description: input.description,
        amount: input.amount,
        isCommissionable: input.isCommissionable,
      },
    });

    return toAdditionalCharge(row);
  }

  async updateAdditionalCharge(
    shipmentId: string,
    id: string,
    input: UpdateAdditionalChargeInput,
  ): Promise<AdditionalCharge> {
    await this.shipments.assertChargesEditable(shipmentId);
    await this.assertAdditionalChargeExists(shipmentId, id);

    const row = await this.prisma.client.additionalCharge.update({
      where: { id },
      data: {
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.isCommissionable === undefined
          ? {}
          : { isCommissionable: input.isCommissionable }),
      },
    });

    return toAdditionalCharge(row);
  }

  async removeAdditionalCharge(shipmentId: string, id: string): Promise<{ removed: true }> {
    await this.shipments.assertChargesEditable(shipmentId);
    await this.assertAdditionalChargeExists(shipmentId, id);

    await this.prisma.client.additionalCharge.softDelete({ id });

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * The id is checked against the shipment in the path, not just against the
   * table. Without that, `DELETE /shipments/A/charges/{id-belonging-to-B}`
   * would quietly edit another shipment's money while passing B's own
   * editability check under A's status.
   */
  private async assertBillableExpenseExists(shipmentId: string, id: string): Promise<void> {
    const found = await this.prisma.client.billableExpense.findFirst({
      where: { id, shipmentId },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException(`No billable expense ${id} on shipment ${shipmentId}`);
    }
  }

  private async assertAdditionalChargeExists(shipmentId: string, id: string): Promise<void> {
    const found = await this.prisma.client.additionalCharge.findFirst({
      where: { id, shipmentId },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException(`No additional charge ${id} on shipment ${shipmentId}`);
    }
  }

  private async assertCategoryExists(categoryId: string | null | undefined): Promise<void> {
    if (!categoryId) return;

    const found = await this.prisma.client.expenseCategory.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest('expenseCategoryId', `No expense category with id ${categoryId}`);
    }
  }

  /**
   * Existence only, deliberately — not `isActive`. A deactivated payee is one
   * no longer OFFERED for new work, and refusing it here would block correcting
   * an expense whose vendor has since been retired. The same rule, and the same
   * argument, as `CompanyPaidExpensesService.assertPayeeExists`.
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

  /**
   * The account named must be one on THIS trip.
   *
   * The composite foreign key already refuses the cross-trip case, so this is
   * not the thing standing between a bad id and the database — it is what turns
   * a raw constraint violation into a message naming the field. Without it,
   * pointing a rebill at another trip's account fails as a 500 that reads like
   * the server broke, on a mistake a user can actually make.
   *
   * SOFT-DELETED ACCOUNTS ARE NOT FOUND, because the extension's default filter
   * applies here: a deleted account carries no lines, so a rebill hung off it
   * would claim its cost lives somewhere that no longer counts anything.
   */
  private async assertLiquidationOnShipment(
    shipmentId: string,
    liquidationId: string | null | undefined,
  ): Promise<void> {
    if (!liquidationId) return;

    const found = await this.prisma.client.liquidation.findFirst({
      where: { id: liquidationId, shipmentId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest(
        'liquidationId',
        `No liquidation ${liquidationId} on shipment ${shipmentId}`,
      );
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

  /**
   * The payee rule to freeze onto a billable expense, which may have no
   * category to take one from.
   *
   * `resolvePayeeRequirement` is the shared statement of the rule and it
   * requires a category, because a liquidation line and a company-paid expense
   * always carry one. A billable expense need not, and an uncategorised row has
   * no rule to freeze: it freezes FALSE, which is also the only value the CHECK
   * accepts without a payee beside it.
   */
  private freezePayeeRule(
    expenseCategoryId: string | null,
    payeeId: string | null,
  ): Promise<boolean> {
    if (expenseCategoryId === null) {
      return Promise.resolve(false);
    }

    return resolvePayeeRequirement(this.prisma.client.expenseCategory, expenseCategoryId, payeeId);
  }

  /**
   * The rule as the patch will leave the row, not as the request states it.
   *
   * `undefined` means "this PATCH did not mention the field", so the current
   * value stands; an explicit `null` means "clear it" — which for the category
   * is a real move here, unlike on a company-paid expense where the column is
   * mandatory. That is why both fields are compared against `undefined` rather
   * than coalesced with `??`, which would quietly ignore a deliberate clear.
   */
  private async resolveRequirementAfterPatch(
    id: string,
    input: UpdateBillableExpenseInput,
  ): Promise<boolean> {
    const current = await this.prisma.client.billableExpense.findFirst({
      where: { id },
      select: { expenseCategoryId: true, payeeId: true },
    });

    if (!current) {
      throw new NotFoundException(`No billable expense with id ${id}`);
    }

    return this.freezePayeeRule(
      input.expenseCategoryId === undefined ? current.expenseCategoryId : input.expenseCategoryId,
      input.payeeId === undefined ? current.payeeId : input.payeeId,
    );
  }
}

const BILLABLE_INCLUDE = {
  expenseCategory: { select: { name: true } },
  payee: { select: { name: true } },
  receipt: { select: { fileName: true } },
  liquidation: { select: { custodian: { select: { firstName: true, lastName: true } } } },
} satisfies Prisma.BillableExpenseInclude;

type BillableExpenseRow = Prisma.BillableExpenseGetPayload<{ include: typeof BILLABLE_INCLUDE }>;

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}

function toBillableExpense(row: BillableExpenseRow): BillableExpense {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    expenseCategoryId: row.expenseCategoryId,
    expenseCategoryName: row.expenseCategory?.name ?? null,
    description: row.description,
    amount: row.amount.toString(),
    spentAt: row.spentAt.toISOString(),
    isCommissionable: row.isCommissionable,
    payeeId: row.payeeId,
    payeeName: row.payee?.name ?? null,
    payeeRequired: row.payeeRequired,
    liquidationId: row.liquidationId,
    liquidationCustodianName: custodianName(row.liquidation?.custodian),
    referenceNumber: row.referenceNumber,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    ...auditFields(row),
  };
}

/**
 * Null for an account with nobody's name on it, which is a real state rather
 * than missing data: a trip's first liquidation is opened at booking, before
 * anyone is assigned to drive it. `liquidationId` is what says whether there is
 * an account at all — this only ever says who answers for one.
 */
function custodianName(
  custodian: { firstName: string; lastName: string } | null | undefined,
): string | null {
  if (!custodian) return null;

  return `${custodian.firstName} ${custodian.lastName}`;
}

function toAdditionalCharge(
  row: Prisma.AdditionalChargeGetPayload<Record<string, never>>,
): AdditionalCharge {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    description: row.description,
    amount: row.amount.toString(),
    isCommissionable: row.isCommissionable,
    ...auditFields(row),
  };
}
