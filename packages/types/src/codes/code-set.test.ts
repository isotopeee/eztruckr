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
  it('pins every ShipmentStatus code', () => {
    expect(ShipmentStatus).toEqual({
      DRAFT: 1,
      DISPATCHED: 2,
      IN_TRANSIT: 3,
      DELIVERED: 4,
      LIQUIDATED: 5,
      CLOSED: 6,
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

  it('pins every CommissionMethod code, including the reserved one', () => {
    expect(CommissionMethod).toEqual({
      PERCENT_OF_BASE: 1,
      FIXED_PER_TRIP: 2,
      FIXED_PER_ROUTE: 3,
      PERCENT_OF_NET_RATE: 4,
      TIERED: 5,
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
    expect(isShipmentStatus(7)).toBe(false);
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

describe('CommissionMethod reservations', () => {
  it('treats TIERED as a valid code but an unimplemented method', () => {
    // The DB CHECK guards the code set, not the feature set — so the code is
    // storable, and refusing it is the service layer's job.
    expect(isCommissionMethod(CommissionMethod.TIERED)).toBe(true);
    expect(isImplementedCommissionMethod(CommissionMethod.TIERED)).toBe(false);
    expect(isImplementedCommissionMethod(CommissionMethod.PERCENT_OF_BASE)).toBe(true);
  });
});
