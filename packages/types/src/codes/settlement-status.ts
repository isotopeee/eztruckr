import { defineCodeSet } from './code-set';

/**
 * Where a shipment's allowance variance has got to. Stored as
 * `settlement.status` SMALLINT.
 *
 * This is the column the "allowances outstanding" alert reads, and it is read
 * DIRECTLY — never inferred from the liquidation. The two answer different
 * questions: an approved liquidation says the spending has been accounted for,
 * which tells you nothing about whether the cash left over ever came back.
 *
 *   OUTSTANDING        the variance is real and nothing has moved yet.
 *   SETTLED            the movement is recorded, or there was nothing to move.
 *   CARRIED_TO_PAYOUT  the crew's balance is being recovered from their pay
 *                      instead of in cash. It becomes SETTLED when the payout
 *                      run recovering it is marked Paid.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const SettlementStatus = {
  OUTSTANDING: 1,
  SETTLED: 2,
  CARRIED_TO_PAYOUT: 3,
} as const;

export type SettlementStatus = (typeof SettlementStatus)[keyof typeof SettlementStatus];

const meta = defineCodeSet('SettlementStatus', SettlementStatus);

export const SETTLEMENT_STATUS_CODES = meta.codes;
export const isSettlementStatus = meta.isValid;
export const settlementStatusSchema = meta.schema;

export const SETTLEMENT_STATUS_LABELS: Readonly<Record<SettlementStatus, string>> = {
  [SettlementStatus.OUTSTANDING]: 'Outstanding',
  [SettlementStatus.SETTLED]: 'Settled',
  [SettlementStatus.CARRIED_TO_PAYOUT]: 'Carried to payout',
};

/**
 * Whether this settlement still represents cash unaccounted for.
 *
 * CARRIED_TO_PAYOUT counts as outstanding: the decision has been made but the
 * money has not moved, and a trip whose balance is waiting on a payout run is
 * exactly what an alert exists to keep visible.
 */
export function isAllowanceOutstanding(status: SettlementStatus): boolean {
  return status !== SettlementStatus.SETTLED;
}
