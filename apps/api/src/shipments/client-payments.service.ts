import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  areChargesEditable,
  isPaymentMethod,
  money,
  paymentStatusOf,
  sum,
  toDecimalString,
  type ClientPayment,
  type ClientPaymentSummary,
  type RecordClientPaymentInput,
  type UpdateClientPaymentInput,
} from '@eztruckr/types';
import {
  normaliseReference,
  referenceFilter,
  repeatedReferenceNumbers,
} from '../common/repeated-references';
import { auditFields } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { revenueAsStrings, shipmentRevenue } from './shipment-revenue';
import { ShipmentsService } from './shipments.service';

/**
 * What the client has paid for a trip, and what is still outstanding.
 *
 * ONE ROW PER PAYMENT, never an editable running total — the same rule, and the
 * same argument, as `AllowancesService`. "How much has this trip collected" is
 * a QUESTION answered by summing receipts, not a FIELD: a field would be
 * overwritten by the balance payment and the downpayment would lose its date,
 * its method and its check number along with it.
 *
 * WHAT IS OWED IS NOT THIS SERVICE'S OPINION. It comes from
 * `shipmentRevenue`, the same function gross profit uses, so an invoice chased
 * on one figure and a margin reported on another cannot happen. Nothing here
 * writes to the P&L and nothing in the P&L reads this table.
 *
 * A PAYMENT MAY BE RECORDED AT ANY STATUS, INCLUDING CLOSED, and that is the
 * deliberate difference from an allowance. A release is refused on a closed
 * trip because a closed trip can no longer account for cash it hands out. A
 * client's payment is the other direction entirely: terms of thirty or sixty
 * days mean the check routinely arrives long after the crew were paid and the
 * trip was closed, and a system that refused it would be a system where the
 * last payment on every trip cannot be recorded. For the same reason, closing a
 * trip does NOT require it to be paid — see `assertReadyToClose`, which asks
 * about the crew's cash and deliberately not about the client's.
 */

const PAYMENT_INCLUDE = {
  receipt: { select: { fileName: true } },
} satisfies Prisma.ClientPaymentInclude;

type PaymentRow = Prisma.ClientPaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

@Injectable()
export class ClientPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  /**
   * Every payment on the trip, what it was billed, and the difference.
   *
   * UNSCOPED, unlike the allowance summary, because there is nobody to scope it
   * to: a crew session never reaches this at all. What the company charges its
   * client is not the crew's business, and the controller keeps CREW off the
   * route rather than blanking fields on the way out.
   */
  async summary(shipmentId: string): Promise<ClientPaymentSummary> {
    const shipment = await this.shipments.load(shipmentId);

    const [rows, income] = await Promise.all([
      this.prisma.client.clientPayment.findMany({
        where: { shipmentId },
        include: PAYMENT_INCLUDE,
        // The order the money arrived in. `createdAt` breaks the tie, so two
        // payments recorded under one date keep the order they were entered.
        orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      }),
      shipmentRevenue(this.prisma, shipmentId, shipment.netRate),
    ]);

    // One check legitimately settles two trips and carries one number on both,
    // so this warns and never refuses. Shared with the allowance's own check so
    // the case-insensitive matching and the across-every-trip search cannot
    // drift apart between the two tables that need them.
    const repeated = await repeatedReferenceNumbers(rows, (references) =>
      this.prisma.client.clientPayment.findMany({
        where: { OR: referenceFilter(references) },
        select: { referenceNumber: true },
      }),
    );

    const amountPaid = sum(rows.map((row) => row.amount));
    const amountDue = income.revenue;

    // The P&L calls this sum `revenue`; an invoice calls it what is owed. Same
    // number, renamed here rather than sent under both keys — a response
    // carrying two names for one figure is an invitation to add them up.
    const { revenue, ...billed } = revenueAsStrings(income);

    return {
      shipmentId,
      ...billed,
      amountDue: revenue,
      // A charge added later moves what is owed, so a balance read while the
      // trip is still open can still grow. Chasing one that is still moving is
      // how a client gets invoiced twice.
      amountDueIsProvisional: areChargesEditable(this.shipments.statusOf(shipment)),

      amountPaid: toDecimalString(amountPaid),
      paymentCount: rows.length,
      // Negative when the client has overpaid, and deliberately not clamped:
      // "we owe them ₱2,000" is a fact somebody has to act on, and a zero
      // would hide it.
      balance: toDecimalString(amountDue.subtract(amountPaid)),
      status: paymentStatusOf(toDecimalString(amountDue), toDecimalString(amountPaid)),

      payments: rows.map((row) => {
        const reference = normaliseReference(row.referenceNumber);

        return {
          ...toClientPayment(row),
          referenceNumberIsDuplicated: reference !== null && repeated.has(reference),
        };
      }),
    };
  }

  /**
   * Records a payment.
   *
   * THE ONLY CHECKS ARE THAT THE TRIP AND THE ATTACHMENT EXIST. There is no
   * status gate on purpose — see the note on the class — and no ceiling on the
   * amount: a payment that exceeds what is owed is reported as an overpayment,
   * because refusing it would refuse a check that genuinely arrived, and
   * because what is owed moves on its own as charges are recorded.
   */
  async record(shipmentId: string, input: RecordClientPaymentInput): Promise<ClientPayment> {
    await this.shipments.load(shipmentId);
    await this.assertReceiptExists(input.receiptId);

    const row = await this.prisma.client.clientPayment.create({
      data: {
        shipmentId,
        amount: input.amount,
        receivedAt: input.receivedAt === null ? new Date() : new Date(input.receivedAt),
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber,
        receiptId: input.receiptId,
        remarks: input.remarks,
      },
      include: PAYMENT_INCLUDE,
    });

    return toClientPayment(row);
  }

  async update(
    shipmentId: string,
    id: string,
    input: UpdateClientPaymentInput,
  ): Promise<ClientPayment> {
    await this.assertBelongs(shipmentId, id);
    await this.assertReceiptExists(input.receiptId);

    const row = await this.prisma.client.clientPayment.update({
      where: { id },
      data: {
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        // `undefined` means the PATCH did not mention the date; an explicit
        // null means "use now", which is what the create does with the same
        // value. Neither may be allowed to blank a NOT NULL column.
        ...(input.receivedAt === undefined || input.receivedAt === null
          ? {}
          : { receivedAt: new Date(input.receivedAt) }),
        ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }),
        ...(input.referenceNumber === undefined ? {} : { referenceNumber: input.referenceNumber }),
        ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
      },
      include: PAYMENT_INCLUDE,
    });

    return toClientPayment(row);
  }

  /**
   * Removes a payment.
   *
   * THIS IS HOW A REFUND AND A BOUNCED CHECK ARE RECORDED, and the reason
   * neither has a record of its own. The soft delete already says who reversed
   * it and when, beside the original amount, date and reference — which is more
   * than a negative row would carry and cannot be mistaken for money received.
   */
  async remove(shipmentId: string, id: string): Promise<{ removed: true }> {
    await this.assertBelongs(shipmentId, id);

    await this.prisma.client.clientPayment.softDelete({ id });

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * The id is checked against the shipment in the path, not just against the
   * table — the same rule every other child of a shipment follows here. Without
   * it, `DELETE /shipments/A/payments/{id-belonging-to-B}` would quietly remove
   * another trip's money.
   */
  private async assertBelongs(shipmentId: string, id: string): Promise<void> {
    const found = await this.prisma.client.clientPayment.findFirst({
      where: { id, shipmentId },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException(`No payment ${id} on shipment ${shipmentId}`);
    }
  }

  private async assertReceiptExists(receiptId: string | null | undefined): Promise<void> {
    if (!receiptId) return;

    const found = await this.prisma.client.receipt.findFirst({
      where: { id: receiptId },
      select: { id: true },
    });

    if (!found) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'receiptId', message: `No receipt with id ${receiptId}` }],
      });
    }
  }
}

export function toClientPayment(row: PaymentRow): ClientPayment {
  if (!isPaymentMethod(row.paymentMethod)) {
    // The column carries a CHECK, so this needs raw SQL to reach. Failing
    // loudly beats returning a payment nobody can interpret.
    throw new Error(`Client payment ${row.id} has an unrecognised payment method`);
  }

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    // At 2dp like every other figure that crosses the wire: `Decimal.toString()`
    // drops trailing zeros, and a list where "5000" sits under "12500.00" reads
    // like two different kinds of number.
    amount: toDecimalString(money(row.amount)),
    receivedAt: row.receivedAt.toISOString(),
    paymentMethod: row.paymentMethod,
    referenceNumber: row.referenceNumber,
    // Costs a query to answer, so only the summary pays for it and overrides
    // this. False means "not checked" — the safe way round, since it never
    // claims a reference is unique when nothing has looked.
    referenceNumberIsDuplicated: false,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    remarks: row.remarks,
    ...auditFields(row),
  };
}
