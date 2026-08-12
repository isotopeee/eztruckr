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
      include: { expenseCategory: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toBillableExpense);
  }

  async addBillableExpense(
    shipmentId: string,
    input: CreateBillableExpenseInput,
  ): Promise<BillableExpense> {
    await this.shipments.assertChargesEditable(shipmentId);
    await this.assertCategoryExists(input.expenseCategoryId);

    const row = await this.prisma.client.billableExpense.create({
      data: {
        shipmentId,
        expenseCategoryId: input.expenseCategoryId,
        description: input.description,
        amount: input.amount,
        isCommissionable: input.isCommissionable,
      },
      include: { expenseCategory: { select: { name: true } } },
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

    const row = await this.prisma.client.billableExpense.update({
      where: { id },
      data: {
        ...(input.expenseCategoryId === undefined
          ? {}
          : { expenseCategoryId: input.expenseCategoryId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.isCommissionable === undefined
          ? {}
          : { isCommissionable: input.isCommissionable }),
      },
      include: { expenseCategory: { select: { name: true } } },
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
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          { path: 'expenseCategoryId', message: `No expense category with id ${categoryId}` },
        ],
      });
    }
  }
}

type BillableExpenseRow = Prisma.BillableExpenseGetPayload<{
  include: { expenseCategory: { select: { name: true } } };
}>;

function toBillableExpense(row: BillableExpenseRow): BillableExpense {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    expenseCategoryId: row.expenseCategoryId,
    expenseCategoryName: row.expenseCategory?.name ?? null,
    description: row.description,
    amount: row.amount.toString(),
    isCommissionable: row.isCommissionable,
    ...auditFields(row),
  };
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
