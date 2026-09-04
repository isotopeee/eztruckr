import { PaymentVerificationStatus } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';
import { receivablesOf } from './receivables';

/**
 * What a trip on the shipments list was billed, and what is left on it.
 *
 * PURE, AND THEREFORE ABOUT THE DEFINITIONS RATHER THAN THE QUERIES. The three
 * reads that feed this are ordinary `IN` lookups the ORM writes; what is worth
 * pinning is which COLUMN each figure comes from and which rows are left out,
 * because every one of those is a decision that has a plausible wrong answer —
 * and the list is the screen where a wrong one is read at a glance across
 * twenty-five clients at once.
 *
 * The billed side's own arithmetic belongs to `revenueOf` and is asserted
 * against gross profit elsewhere; this suite asserts that the grouping hands it
 * the right trip's rows and that the subtraction underneath is the payments
 * card's.
 */

const trip = (id: string, netRate: string) => ({ id, netRate });

const rebill = (shipmentId: string, amount: string, billedAmount: string) => ({
  shipmentId,
  amount,
  billedAmount,
  liquidationId: null,
});

const charge = (shipmentId: string, amount: string) => ({ shipmentId, amount });

const payment = (
  shipmentId: string,
  amount: string,
  verificationStatus: number = PaymentVerificationStatus.VERIFIED,
) => ({ shipmentId, amount, verificationStatus });

describe('a trip on the shipments list', () => {
  it('bills the freight, the rebills and the charges', () => {
    const receivables = receivablesOf(
      [trip('a', '45000')],
      [rebill('a', '2000', '2000')],
      [charge('a', '500')],
      [],
    );

    expect(receivables.get('a')?.amountDue).toBe('47500.00');
  });

  /**
   * WHAT IS CHARGED, NOT WHAT WAS SPENT. A ₱2,000 permit rebilled at ₱1,500
   * owes the client ₱1,500; reading `amount` here would invoice them for a
   * discount somebody agreed to give them.
   */
  it('bills a partially recovered rebill at what was billed', () => {
    const receivables = receivablesOf([trip('a', '45000')], [rebill('a', '2000', '1500')], [], []);

    expect(receivables.get('a')?.amountDue).toBe('46500.00');
  });

  it('takes what has been collected off the balance', () => {
    const receivables = receivablesOf([trip('a', '45000')], [], [], [payment('a', '20000')]);

    expect(receivables.get('a')?.balance).toBe('25000.00');
  });

  /**
   * An unverified payment still counts: money that arrived does not become
   * less arrived while it waits for a tick. A RETURNED one does not — somebody
   * looked and stated they could not match it.
   */
  it('counts an unverified payment and not a returned one', () => {
    const receivables = receivablesOf(
      [trip('a', '45000')],
      [],
      [],
      [
        payment('a', '20000', PaymentVerificationStatus.UNVERIFIED),
        payment('a', '25000', PaymentVerificationStatus.RETURNED),
      ],
    );

    expect(receivables.get('a')?.balance).toBe('25000.00');
  });

  /**
   * NEGATIVE, NOT CLAMPED, exactly as on the payments card: "we owe them
   * ₱2,000" is a fact somebody has to act on, and a zero would hide it on the
   * one screen where every client is in view at once.
   */
  it('reports an overpayment as a negative balance', () => {
    const receivables = receivablesOf([trip('a', '45000')], [], [], [payment('a', '47000')]);

    expect(receivables.get('a')?.balance).toBe('-2000.00');
  });

  /** The grouping is the whole risk of batching: one trip's charges must not
   * reach another's row. */
  it('keeps each trip to its own charges and payments', () => {
    const receivables = receivablesOf(
      [trip('a', '45000'), trip('b', '30000')],
      [rebill('a', '2000', '2000')],
      [charge('b', '1000')],
      [payment('a', '10000'), payment('b', '31000')],
    );

    expect(receivables.get('a')).toEqual({ amountDue: '47000.00', balance: '37000.00' });
    expect(receivables.get('b')).toEqual({ amountDue: '31000.00', balance: '0.00' });
  });

  /**
   * A freight-only trip owes its net rate. Omitting it would leave the row
   * blank, which reads as "not computed" rather than as "nothing rebilled".
   */
  it('answers for a trip with no charges and no payments at all', () => {
    const receivables = receivablesOf([trip('a', '45000')], [], [], []);

    expect(receivables.get('a')).toEqual({ amountDue: '45000.00', balance: '45000.00' });
  });
});
