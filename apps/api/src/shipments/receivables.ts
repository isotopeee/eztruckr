import {
  countsAsCollected,
  isPaymentVerificationStatus,
  sum,
  toDecimalString,
  type Money,
} from '@eztruckr/types';
import { revenueOf, type AdditionalChargeRow, type BillableExpenseRow } from './shipment-revenue';

/**
 * Where a trip stands with its client: what it was billed, and what is left.
 *
 * TWO FIGURES THAT ALREADY EXIST, batched. `ClientPaymentsService.summary`
 * answers both for ONE trip and is the screen a person opens to argue about
 * them; the shipments list wants the same pair on every row of a page, and
 * twenty-five summaries is seventy-five round trips for a table nobody asked
 * to be slow. So the QUERIES are here and the ARITHMETIC is shared — the billed
 * side through `revenueOf`, which is also what gross profit and the P&L use,
 * and the collected side through `collectedAmount` below, which the summary
 * itself now calls.
 *
 * The alternative was a second subtraction written against SQL aggregates,
 * which is how a list quietly starts disagreeing with the card one click away.
 */
export interface Receivable {
  /** The whole invoice — freight, rebills and charges. `revenueOf`'s sum. */
  amountDue: string;
  /**
   * What is still outstanding. Negative when the client has overpaid, and
   * deliberately not clamped, for the reason given on the summary: "we owe them
   * ₱2,000" is a fact somebody has to act on and a zero would hide it.
   */
  balance: string;
}

/**
 * What a trip has collected.
 *
 * A RETURNED payment is left out: somebody looked and stated they could not
 * match it, which is a different thing from nobody having looked yet. It
 * rejoins the moment it is corrected.
 *
 * An UNRECOGNISED code counts, which is the same way round the summary has
 * always had it — a status this build does not know about is not evidence that
 * the money never arrived.
 */
export function collectedAmount(
  rows: readonly { amount: { toString(): string }; verificationStatus: number }[],
): Money {
  return sum(
    rows
      .filter(
        (row) =>
          !isPaymentVerificationStatus(row.verificationStatus) ||
          countsAsCollected(row.verificationStatus),
      )
      .map((row) => row.amount),
  );
}

/**
 * The same two figures, from rows somebody else loaded.
 *
 * Pure, and grouped by shipment id, so the query above and the period report
 * that may one day want this can share the arithmetic without either re-reading
 * the other's rows. Trips with no charges and no payments still get an entry —
 * a freight-only trip owes its net rate, and omitting it would make "no rebills
 * yet" look like "not computed".
 */
export function receivablesOf(
  shipments: readonly { id: string; netRate: { toString(): string } }[],
  billable: readonly ({ shipmentId: string } & BillableExpenseRow)[],
  additional: readonly ({ shipmentId: string } & AdditionalChargeRow)[],
  payments: readonly {
    shipmentId: string;
    amount: { toString(): string };
    verificationStatus: number;
  }[],
): Map<string, Receivable> {
  const by = <T extends { shipmentId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const grouped = new Map<string, T[]>();

    for (const row of rows) {
      const existing = grouped.get(row.shipmentId);
      if (existing) existing.push(row);
      else grouped.set(row.shipmentId, [row]);
    }

    return grouped;
  };

  const billableBy = by(billable);
  const additionalBy = by(additional);
  const paymentsBy = by(payments);

  return new Map(
    shipments.map((shipment) => {
      const income = revenueOf(
        shipment.netRate,
        billableBy.get(shipment.id) ?? [],
        additionalBy.get(shipment.id) ?? [],
      );
      const collected = collectedAmount(paymentsBy.get(shipment.id) ?? []);

      return [
        shipment.id,
        {
          amountDue: toDecimalString(income.revenue),
          balance: toDecimalString(income.revenue.subtract(collected)),
        },
      ];
    }),
  );
}
