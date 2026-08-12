/**
 * A commission could not be computed.
 *
 * Always a refusal, never a fallback. There is no default rate in this system:
 * `SystemSetting.driverCommissionRate` and its helper twin existed for exactly
 * that purpose and were deliberately dropped, because a silent default turns a
 * missing or mis-scoped rule into a plausible wrong number that then freezes
 * onto a commission and is not questioned until someone disputes a payout.
 *
 * So every failure below stops the computation and reaches the user with the
 * reason. Nothing here returns zero and carries on.
 */
export class CommissionComputationError extends Error {
  constructor(
    message: string,
    /** Which crew slot the failure belongs to, when it belongs to one. */
    readonly role?: 'DRIVER' | 'HELPER',
  ) {
    super(message);
    this.name = 'CommissionComputationError';
  }
}
