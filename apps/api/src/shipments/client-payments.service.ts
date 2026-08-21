import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  areChargesEditable,
  countsAsCollected,
  isPaymentMethod,
  isPaymentVerificationStatus,
  money,
  PaymentVerificationStatus,
  paymentStatusOf,
  sum,
  toDecimalString,
  type ClientPayment,
  type ClientPaymentListQuery,
  type ClientPaymentSummary,
  type ReturnClientPaymentInput,
  type RecordClientPaymentInput,
  type UpdateClientPaymentInput,
  type UserRole,
} from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { CAN_VERIFY_CLIENT_PAYMENT } from '../auth/role-policy';
import {
  normaliseReference,
  referenceFilter,
  repeatedReferenceNumbers,
} from '../common/repeated-references';
import { auditFields, dateToIso } from '../master-data/serialize';
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
  shipment: { select: { shipmentNumber: true, client: { select: { name: true } } } },
  createdByUser: { select: { name: true } },
  verifiedByUser: { select: { name: true } },
} satisfies Prisma.ClientPaymentInclude;

/**
 * Whether this session may check somebody else's work — and therefore whether
 * what it records needs checking at all.
 *
 * ONE PREDICATE, consulted by the create, the edit and both decisions, because
 * they are one question asked four times. A second spelling of it is how the
 * edit path ends up quietly more generous than the create path, which is the
 * failure this codebase keeps having.
 */
function mayVerify(role: UserRole): boolean {
  return (CAN_VERIFY_CLIENT_PAYMENT as readonly UserRole[]).includes(role);
}

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

    // A RETURNED payment is left out of what the trip has collected: somebody
    // looked and stated they could not match it, which is a different thing
    // from nobody having looked yet. It rejoins the moment it is corrected.
    const counted = rows.filter(
      (row) =>
        !isPaymentVerificationStatus(row.verificationStatus) ||
        countsAsCollected(row.verificationStatus),
    );
    const verified = rows.filter(
      (row) => row.verificationStatus === PaymentVerificationStatus.VERIFIED,
    );
    const returned = rows.filter(
      (row) => row.verificationStatus === PaymentVerificationStatus.RETURNED,
    );

    const amountPaid = sum(counted.map((row) => row.amount));
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
      // What a second person has actually confirmed against the bank. Reported
      // beside the total rather than instead of it, so nobody reads one as the
      // other.
      amountVerified: toDecimalString(sum(verified.map((row) => row.amount))),
      amountReturned: toDecimalString(sum(returned.map((row) => row.amount))),
      awaitingVerification: rows.filter(
        (row) => row.verificationStatus === PaymentVerificationStatus.UNVERIFIED,
      ).length,
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
   * The cross-trip queue: what accounting has waiting on them.
   *
   * OLDEST FIRST, because a queue worked from the top is a queue worked in the
   * order the money arrived — and the payment that has been sitting longest is
   * the client whose statement line is hardest to still find.
   *
   * UNSCOPED. Every role that can reach this endpoint reads receivables
   * already, so filtering it to the caller's own entries would hide a
   * colleague's work from the accountant who has to check it, while leaving it
   * one click away on the trip.
   */
  async list(query: ClientPaymentListQuery): Promise<ClientPayment[]> {
    const rows = await this.prisma.client.clientPayment.findMany({
      where: { verificationStatus: query.verificationStatus },
      include: PAYMENT_INCLUDE,
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toClientPayment);
  }

  /**
   * Records a payment.
   *
   * THE ONLY CHECKS ARE THAT THE TRIP AND THE ATTACHMENT EXIST. There is no
   * status gate on purpose — see the note on the class — and no ceiling on the
   * amount: a payment that exceeds what is owed is reported as an overpayment,
   * because refusing it would refuse a check that genuinely arrived, and
   * because what is owed moves on its own as charges are recorded.
   *
   * WHO RECORDED IT DECIDES WHETHER IT NEEDS CHECKING. A dispatch manager's
   * entry arrives UNVERIFIED and joins accounting's queue; an accountant's own
   * arrives VERIFIED, stamped to them. That is not a hole in the control — the
   * queue exists to hold work needing a SECOND pair of eyes, and an accountant
   * booking a payment off the statement in front of them has already been both
   * people. Padding the queue with rows nobody can learn anything from is how a
   * queue starts being bulk-cleared without reading.
   */
  async record(
    shipmentId: string,
    input: RecordClientPaymentInput,
    user: RequestUser,
  ): Promise<ClientPayment> {
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
        ...verificationOnWriteBy(user),
      },
      include: PAYMENT_INCLUDE,
    });

    return toClientPayment(row);
  }

  /**
   * Corrects one.
   *
   * A VERIFIED PAYMENT IS CLOSED TO WHOEVER CANNOT VERIFY IT, which is the lock
   * this whole state exists to provide — the same shape as a liquidation being
   * frozen by its own approval. Without it, the control is theatre: record
   * something unremarkable, wait for the tick, then change the amount.
   *
   * AND THE EDIT RE-DECIDES THE STATE. A dispatch manager answering a return
   * puts the row back to UNVERIFIED, so accounting sees it again rather than
   * having to remember it; an accountant editing anything has, by editing it,
   * just looked at it, so it re-stamps to them. Both fall out of the one
   * predicate, so the two paths cannot drift.
   */
  async update(
    shipmentId: string,
    id: string,
    input: UpdateClientPaymentInput,
    user: RequestUser,
  ): Promise<ClientPayment> {
    const existing = await this.assertBelongs(shipmentId, id);
    this.assertMayAlter(existing, user, 'changed');
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
        ...verificationOnWriteBy(user),
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
   *
   * A VERIFIED PAYMENT IS ACCOUNTING'S TO REVERSE, for the same reason it is
   * theirs to edit: once a second person has confirmed the money arrived, the
   * person who recorded it cannot make it disappear.
   */
  async remove(shipmentId: string, id: string, user: RequestUser): Promise<{ removed: true }> {
    const existing = await this.assertBelongs(shipmentId, id);
    this.assertMayAlter(existing, user, 'reversed');

    await this.prisma.client.clientPayment.softDelete({ id });

    return { removed: true };
  }

  // --- accounting's half ---------------------------------------------------

  /**
   * Confirming one against the bank.
   *
   * NO PAYLOAD, deliberately — see `verifyClientPaymentSchema`. Verifying says
   * the row AS IT STANDS matches the statement; a figure supplied here would
   * let "verified" be stamped on something quietly changed in the same breath.
   *
   * THE FIRST VERIFICATION IS THE RECORD, and re-verifying an already verified
   * payment is REFUSED rather than allowed to overwrite it. There is no history
   * table here, so a second stamp does not record that two people looked — it
   * erases the fact that the first one did, permanently and with nothing saying
   * so. No question is answered by it; somebody who thinks the first check was
   * wrong returns the payment for correction, which IS recorded.
   *
   * Returning one that is already returned does replace the reason, because the
   * second reason is the current one and the first was already acted on.
   */
  async verify(id: string, user: RequestUser): Promise<ClientPayment> {
    const existing = await this.load(id);

    if (existing.verificationStatus === PaymentVerificationStatus.VERIFIED) {
      throw new ConflictException(
        'That payment is already verified. Confirming it again would replace the name and date of whoever checked it first, and nothing would record that it had. If it is wrong, return it for correction.',
      );
    }

    const row = await this.prisma.client.clientPayment.update({
      where: { id },
      data: {
        verificationStatus: PaymentVerificationStatus.VERIFIED,
        verifiedBy: user.id,
        verifiedAt: new Date(),
        // Cleared, not left: the CHECK refuses a note on a verified row, and a
        // stale return reason beside a confirmed payment would read as an
        // outstanding problem that has in fact been resolved.
        verificationNote: null,
      },
      include: PAYMENT_INCLUDE,
    });

    return toClientPayment(row);
  }

  /** Handing one back for correction, with the reason that makes it actionable. */
  async returnForCorrection(
    id: string,
    input: ReturnClientPaymentInput,
    user: RequestUser,
  ): Promise<ClientPayment> {
    await this.load(id);

    const row = await this.prisma.client.clientPayment.update({
      where: { id },
      data: {
        verificationStatus: PaymentVerificationStatus.RETURNED,
        verifiedBy: user.id,
        verifiedAt: new Date(),
        verificationNote: input.reason,
      },
      include: PAYMENT_INCLUDE,
    });

    return toClientPayment(row);
  }

  // -------------------------------------------------------------------------

  /**
   * The id is checked against the shipment in the path, not just against the
   * table — the same rule every other child of a shipment follows here. Without
   * it, `DELETE /shipments/A/payments/{id-belonging-to-B}` would quietly remove
   * another trip's money.
   */
  private async assertBelongs(
    shipmentId: string,
    id: string,
  ): Promise<{ id: string; verificationStatus: number }> {
    const found = await this.prisma.client.clientPayment.findFirst({
      where: { id, shipmentId },
      select: { id: true, verificationStatus: true },
    });

    if (!found) {
      throw new NotFoundException(`No payment ${id} on shipment ${shipmentId}`);
    }

    return found;
  }

  private async load(id: string): Promise<{ id: string; verificationStatus: number }> {
    const found = await this.prisma.client.clientPayment.findFirst({
      where: { id },
      select: { id: true, verificationStatus: true },
    });

    if (!found) {
      throw new NotFoundException(`No payment with id ${id}`);
    }

    return found;
  }

  /**
   * A confirmed payment is closed to whoever cannot confirm one.
   *
   * THE LOCK THE VERIFICATION STATE EXISTS FOR, and the same shape as a
   * liquidation frozen by its own approval. The alternative — letting the
   * recorder edit a verified row and silently resetting it — sounds gentler and
   * is worse: the amount accounting signed off would change, and the only trace
   * would be a status quietly going backwards.
   */
  private assertMayAlter(
    payment: { verificationStatus: number },
    user: RequestUser,
    verb: string,
  ): void {
    if (mayVerify(user.role)) return;
    if (payment.verificationStatus !== PaymentVerificationStatus.VERIFIED) return;

    throw new ConflictException(
      `That payment has been verified by accounting, so it can no longer be ${verb} from this desk. Ask accounting to correct it, or to return it for correction if it is wrong.`,
    );
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

/**
 * The verification columns a write by this session should leave behind.
 *
 * ONE HELPER FOR THE CREATE AND THE EDIT, because they are the same decision:
 * has this row just been looked at by somebody entitled to say so? An
 * accountant's write stamps VERIFIED to them; anybody else's puts the row into
 * the queue and clears whatever return it was answering.
 *
 * ALL FOUR COLUMNS ARE ALWAYS WRITTEN, never a subset — the CHECK enforces the
 * combination, so a partial update is how a row ends up refused by the database
 * for a reason the caller cannot see.
 */
function verificationOnWriteBy(user: RequestUser) {
  return mayVerify(user.role)
    ? {
        verificationStatus: PaymentVerificationStatus.VERIFIED,
        verifiedBy: user.id,
        verifiedAt: new Date(),
        verificationNote: null,
      }
    : {
        verificationStatus: PaymentVerificationStatus.UNVERIFIED,
        verifiedBy: null,
        verifiedAt: null,
        verificationNote: null,
      };
}

export function toClientPayment(row: PaymentRow): ClientPayment {
  if (!isPaymentMethod(row.paymentMethod)) {
    // The column carries a CHECK, so this needs raw SQL to reach. Failing
    // loudly beats returning a payment nobody can interpret.
    throw new Error(`Client payment ${row.id} has an unrecognised payment method`);
  }

  if (!isPaymentVerificationStatus(row.verificationStatus)) {
    throw new Error(`Client payment ${row.id} has an unrecognised verification status`);
  }

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment?.shipmentNumber ?? null,
    clientName: row.shipment?.client?.name ?? null,
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

    verificationStatus: row.verificationStatus,
    verifiedBy: row.verifiedBy,
    verifiedByName: row.verifiedByUser?.name ?? null,
    verifiedAt: dateToIso(row.verifiedAt),
    verificationNote: row.verificationNote,
    recordedByName: row.createdByUser?.name ?? null,

    ...auditFields(row),
  };
}
