import { describe, expect, it } from 'vitest';
import { DisbursementMode } from '../codes/disbursement-mode';
import {
  approveAllowanceRequestSchema,
  createAllowanceRequestSchema,
  declineAllowanceRequestSchema,
} from './allowance-request';

const id = '01931f4c-0000-7000-8000-000000000001';

describe('approving is refused without proof, but only where proof exists to attach', () => {
  /**
   * THE ONE RULE THIS FLOW ADDS, and the argument for it is the difference
   * between typing and uploading. A reference number is typed, so requiring one
   * yields "N/A" — which is why `referenceNumber` stays optional for every mode
   * here, exactly as on a direct release. A receipt is uploaded, so requiring
   * one yields either the document or a refusal, and both bank transfers and
   * wallet payments produce that document as a side effect of happening.
   */
  it.each([DisbursementMode.BANK_TRANSFER, DisbursementMode.EWALLET])(
    'refuses mode %i with no receipt',
    (disbursementMode) => {
      const result = approveAllowanceRequestSchema.safeParse({ disbursementMode });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['receiptId']);
    },
  );

  it.each([DisbursementMode.BANK_TRANSFER, DisbursementMode.EWALLET])(
    'accepts mode %i once the confirmation is attached',
    (disbursementMode) => {
      expect(
        approveAllowanceRequestSchema.safeParse({ disbursementMode, receiptId: id }).success,
      ).toBe(true);
    },
  );

  /**
   * Cash in the yard produces nothing. Demanding an attachment here is how a
   * photograph of a blank page ends up in the bucket looking like evidence.
   */
  it('accepts cash with nothing attached', () => {
    const result = approveAllowanceRequestSchema.safeParse({
      disbursementMode: DisbursementMode.CASH,
    });

    expect(result.success).toBe(true);
    expect(result.data?.receiptId).toBeNull();
  });

  /** Never required, whatever the mode — the half of this that stays a prompt. */
  it('never requires a reference number, transfer included', () => {
    const result = approveAllowanceRequestSchema.safeParse({
      disbursementMode: DisbursementMode.BANK_TRANSFER,
      receiptId: id,
    });

    expect(result.success).toBe(true);
    expect(result.data?.referenceNumber).toBeNull();
  });

  /**
   * The whole point of the "approve as requested" decision: there is no amount
   * on this payload, so a stray one is stripped rather than honoured. Releasing
   * less than was asked for is a decline, not an approval of a smaller figure.
   */
  it('strips an amount somebody tried to approve with', () => {
    const parsed = approveAllowanceRequestSchema.parse({
      disbursementMode: DisbursementMode.CASH,
      amount: '1.00',
    });

    expect(parsed).not.toHaveProperty('amount');
  });
});

describe('a decline has to say why', () => {
  it('refuses an empty reason', () => {
    expect(declineAllowanceRequestSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(declineAllowanceRequestSchema.safeParse({}).success).toBe(false);
  });

  it('trims the reason it keeps', () => {
    expect(
      declineAllowanceRequestSchema.parse({ reason: '  Too much for this lane ' }).reason,
    ).toBe('Too much for this lane');
  });
});

describe('an ask names an account, a recipient, a positive amount and a purpose', () => {
  const base = { liquidationId: id, staffId: id, amount: '10000.00', purpose: 'Fuel and toll' };

  it('accepts the ordinary case and trims the purpose', () => {
    expect(
      createAllowanceRequestSchema.parse({ ...base, purpose: '  Fuel and toll ' }).purpose,
    ).toBe('Fuel and toll');
  });

  /**
   * THE ONE MANDATORY FREE-TEXT FIELD in this API, and the reason it is not
   * `optionalText` like every neighbour: that helper collapses a blank to null,
   * so a whitespace-only purpose would have become a row with no ask in it.
   * Accounting decides on this sentence.
   */
  it.each(['', '   ', undefined])('refuses a purpose of %p', (purpose) => {
    expect(createAllowanceRequestSchema.safeParse({ ...base, purpose }).success).toBe(false);
  });

  /** Zero is not a request, and a negative one is a settlement in the wrong table. */
  it.each(['0', '0.00', '-500.00'])('refuses %s', (amount) => {
    expect(createAllowanceRequestSchema.safeParse({ ...base, amount }).success).toBe(false);
  });

  it('refuses an ask with no account to book it against', () => {
    expect(
      createAllowanceRequestSchema.safeParse({ staffId: id, amount: '1.00', purpose: 'Fuel' })
        .success,
    ).toBe(false);
  });
});
