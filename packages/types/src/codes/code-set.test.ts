import { describe, expect, it } from 'vitest';
import {
  AdjustmentDirection,
  CommissionMethod,
  CrewRole,
  LiquidationStatus,
  PayoutRunStatus,
  ShipmentStatus,
  UserRole,
  isCommissionMethod,
  isImplementedCommissionMethod,
  IMPLEMENTED_COMMISSION_METHODS,
  isShipmentStatus,
  shipmentStatusAtLeast,
  SHIPMENT_STATUS_LABELS,
  USER_ROLE_LABELS,
  COMMISSION_METHOD_LABELS,
} from './index';

/**
 * These assertions are the guarantee that codes never move.
 *
 * A stored row holds the number, not the name, so renumbering silently
 * rewrites history: every shipment that was DELIVERED would become something
 * else. If one of these fails, the fix is almost never to update the
 * expectation — it is to restore the original value and append instead.
 */
describe('code sets are permanent', () => {
  /**
   * Renumbered once, in Phase 4, by explicit decision.
   *
   * PENDING_LIQUIDATION was specified from the start and omitted in Phase 2,
   * which left LIQUIDATED on 5 and CLOSED on 6. They moved to 6 and 7 while
   * the `shipment` table was still empty, so no stored row changed meaning —
   * which is the only circumstance in which the rule above does not apply.
   * Shipments exist now, so this map is frozen for good.
   */
  it('pins every ShipmentStatus code', () => {
    expect(ShipmentStatus).toEqual({
      DRAFT: 1,
      DISPATCHED: 2,
      IN_TRANSIT: 3,
      DELIVERED: 4,
      PENDING_LIQUIDATION: 5,
      LIQUIDATED: 6,
      CLOSED: 7,
    });
  });

  it('pins every LiquidationStatus code', () => {
    expect(LiquidationStatus).toEqual({ SUBMITTED: 1, APPROVED: 2, FINALIZED: 3 });
  });

  it('pins every CrewRole code', () => {
    expect(CrewRole).toEqual({ DRIVER: 1, HELPER: 2 });
  });

  it('pins every AdjustmentDirection code', () => {
    expect(AdjustmentDirection).toEqual({ INCREASE: 1, DECREASE: 2 });
  });

  it('pins every UserRole code', () => {
    expect(UserRole).toEqual({
      ADMINISTRATOR: 1,
      OPERATIONS: 2,
      ACCOUNTING: 3,
      MANAGEMENT: 4,
      CREW: 5,
    });
  });

  /**
   * Code 5 was renamed from TIERED to FORMULA in Phase 4. TIERED was never
   * specified — it was a leftover from a reverted feature — and no rule row
   * ever used it, so only an unused code's meaning changed.
   */
  it('pins every CommissionMethod code', () => {
    expect(CommissionMethod).toEqual({
      PERCENT_OF_BASE: 1,
      FIXED_PER_TRIP: 2,
      FIXED_PER_ROUTE: 3,
      PERCENT_OF_NET_RATE: 4,
      FORMULA: 5,
    });
  });

  it('pins every PayoutRunStatus code', () => {
    expect(PayoutRunStatus).toEqual({ DRAFT: 1, APPROVED: 2, PAID: 3, VOIDED: 4 });
  });

  it('never reuses a code within a set', () => {
    for (const set of [
      ShipmentStatus,
      LiquidationStatus,
      CrewRole,
      AdjustmentDirection,
      UserRole,
      CommissionMethod,
      PayoutRunStatus,
    ]) {
      const values = Object.values(set);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('gives every code a display label', () => {
    // A missing label surfaces as a blank cell in the UI rather than an error,
    // so it is worth asserting rather than trusting the Record type.
    for (const code of Object.values(ShipmentStatus)) {
      expect(SHIPMENT_STATUS_LABELS[code]).toBeTruthy();
    }
    for (const code of Object.values(UserRole)) {
      expect(USER_ROLE_LABELS[code]).toBeTruthy();
    }
    for (const code of Object.values(CommissionMethod)) {
      expect(COMMISSION_METHOD_LABELS[code]).toBeTruthy();
    }
  });
});

describe('code guards', () => {
  it('accepts valid codes and rejects everything else', () => {
    expect(isShipmentStatus(ShipmentStatus.CLOSED)).toBe(true);
    expect(isShipmentStatus(0)).toBe(false);
    // One past the highest allocated code, so this moves whenever one is
    // appended — which is the point of asserting it at all.
    expect(isShipmentStatus(8)).toBe(false);
    expect(isShipmentStatus(2.5)).toBe(false);
    expect(isShipmentStatus('2')).toBe(false);
    expect(isShipmentStatus(null)).toBe(false);
    expect(isShipmentStatus(undefined)).toBe(false);
  });
});

describe('order-dependent logic', () => {
  it('compares by workflow position, not by numeric code', () => {
    expect(shipmentStatusAtLeast(ShipmentStatus.CLOSED, ShipmentStatus.LIQUIDATED)).toBe(true);
    expect(shipmentStatusAtLeast(ShipmentStatus.DELIVERED, ShipmentStatus.LIQUIDATED)).toBe(false);
    // "cannot close before it is liquidated"
    expect(shipmentStatusAtLeast(ShipmentStatus.LIQUIDATED, ShipmentStatus.LIQUIDATED)).toBe(true);
  });

  it('does not depend on codes being contiguous or monotonic', () => {
    // Rank comes from the declared sequence, so a status appended later with a
    // high code would still sort by its position in the workflow.
    const ranks = [
      ShipmentStatus.DRAFT,
      ShipmentStatus.DISPATCHED,
      ShipmentStatus.IN_TRANSIT,
      ShipmentStatus.DELIVERED,
      ShipmentStatus.LIQUIDATED,
      ShipmentStatus.CLOSED,
    ].map((status, index) => ({ status, index }));

    for (const { status, index } of ranks) {
      for (const other of ranks) {
        expect(shipmentStatusAtLeast(status, other.status)).toBe(index >= other.index);
      }
    }
  });
});

describe('CommissionMethod', () => {
  it('implements every allocated method as of Phase 4', () => {
    // Code 5 briefly held a TIERED method no specification asked for, left
    // over from a reverted feature. It is FORMULA, which the brief always
    // named there, and all five now have strategies.
    for (const method of Object.values(CommissionMethod)) {
      expect(isCommissionMethod(method)).toBe(true);
      expect(isImplementedCommissionMethod(method)).toBe(true);
    }

    expect(CommissionMethod.FORMULA).toBe(5);
  });

  it('keeps the check available for a future reserved code', () => {
    // The DB CHECK guards the code set, not the feature set, so a code can be
    // appended before its strategy exists. Refusing it stays the service
    // layer's job, via this list.
    expect(IMPLEMENTED_COMMISSION_METHODS).toHaveLength(Object.values(CommissionMethod).length);
  });
});
