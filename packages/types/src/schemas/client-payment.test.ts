import { describe, expect, it } from 'vitest';
import { PaymentMethod, expectsPaymentReference } from '../codes/payment-method';
import { paymentStatusOf, receivedMoneySchema, recordClientPaymentSchema } from './client-payment';

/**
 * Where a trip stands against what it was billed.
 *
 * Tested here rather than only through the API because this is the sentence a
 * screen puts beside a client's name, and the two ends of the ladder — nothing
 * received, and more received than was asked for — are the ones a naive
 * comparison gets wrong.
 */
describe('the payment status ladder', () => {
  it('reports UNPAID when nothing has come in', () => {
    expect(paymentStatusOf('45000.00', '0.00')).toBe('UNPAID');
  });

  it('reports PARTIALLY_PAID for a downpayment', () => {
    expect(paymentStatusOf('45000.00', '20000.00')).toBe('PARTIALLY_PAID');
  });

  it('reports PAID only on the exact figure', () => {
    expect(paymentStatusOf('45000.00', '45000.00')).toBe('PAID');
    expect(paymentStatusOf('45000.00', '44999.99')).toBe('PARTIALLY_PAID');
  });

  /**
   * REPORTED, NEVER REFUSED. One check applied to the wrong trip, a client
   * rounding up, a charge removed after the invoice went out — and the amount
   * due moves on its own as charges are recorded, so a payment that was exact
   * on Tuesday can be an overpayment on Wednesday with nobody touching it.
   */
  it('reports OVERPAID rather than clamping to PAID', () => {
    expect(paymentStatusOf('45000.00', '45000.01')).toBe('OVERPAID');
    expect(paymentStatusOf('45000.00', '50000.00')).toBe('OVERPAID');
  });

  /**
   * THE ORDER OF THE CHECKS IS THE ASSERTION. A trip with nothing billed has a
   * zero balance, and "paid in full" beside it would tell accounting a client
   * has settled when they have never been asked for anything. Uninformative
   * beats wrong.
   */
  it('does not call an unbilled trip paid', () => {
    expect(paymentStatusOf('0.00', '0.00')).toBe('UNPAID');
  });

  it('still calls money against an unbilled trip an overpayment', () => {
    expect(paymentStatusOf('0.00', '500.00')).toBe('OVERPAID');
  });
});

describe('a received amount', () => {
  it('accepts an ordinary payment', () => {
    expect(receivedMoneySchema.safeParse('12500.00').success).toBe(true);
  });

  /**
   * A REFUND IS NOT A NEGATIVE PAYMENT and a bounced check is not either. Both
   * are the removal of a receipt that turns out not to have happened, which the
   * soft delete records with who reversed it and when — and which cannot be
   * mistaken for money that arrived.
   */
  it.each(['0.00', '-500.00'])('refuses %s', (amount) => {
    expect(receivedMoneySchema.safeParse(amount).success).toBe(false);
  });
});

describe('recording one', () => {
  const valid = { amount: '1000.00', paymentMethod: PaymentMethod.CHECK };

  /**
   * Optional for every method, check included. The alternative is a required
   * field answered with "N/A", which looks like evidence and is not — the same
   * call the allowance made, and the reason `expectsPaymentReference` is a
   * prompt rather than a rule.
   */
  it('accepts a payment with no reference at all', () => {
    const result = recordClientPaymentSchema.safeParse(valid);

    expect(result.success).toBe(true);
    expect(result.data?.referenceNumber).toBeNull();
    expect(result.data?.receivedAt).toBeNull();
  });

  it('collapses a blank reference to null rather than storing ""', () => {
    expect(
      recordClientPaymentSchema.parse({ ...valid, referenceNumber: '   ' }).referenceNumber,
    ).toBeNull();
  });

  it('refuses a method outside the code set', () => {
    expect(recordClientPaymentSchema.safeParse({ ...valid, paymentMethod: 9 }).success).toBe(false);
  });
});

/**
 * A check number IS the reference, and it is the one number a client quotes
 * when they ring to ask whether their payment landed — so the form asks for it,
 * exactly as it asks after a transfer.
 */
describe('which methods the form prompts for a reference', () => {
  it.each([PaymentMethod.BANK_TRANSFER, PaymentMethod.EWALLET, PaymentMethod.CHECK])(
    'prompts for method %i',
    (method) => {
      expect(expectsPaymentReference(method)).toBe(true);
    },
  );

  it('does not prompt for cash', () => {
    expect(expectsPaymentReference(PaymentMethod.CASH)).toBe(false);
  });
});
