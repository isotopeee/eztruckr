import { describe, expect, it } from 'vitest';
import { LiquidationStatus } from '../codes/liquidation-status';
import { summariseLiquidations } from './shipment';

const { PENDING, SUBMITTED, APPROVED } = LiquidationStatus;

describe('summariseLiquidations', () => {
  it('reports no status for a trip with no accounts', () => {
    expect(summariseLiquidations([])).toEqual({
      liquidationStatus: null,
      liquidationAccounts: 0,
      liquidationsApproved: 0,
    });
  });

  it('is the least advanced account, whatever order they arrive in', () => {
    expect(summariseLiquidations([APPROVED, SUBMITTED]).liquidationStatus).toBe(SUBMITTED);
    expect(summariseLiquidations([SUBMITTED, APPROVED, PENDING]).liquidationStatus).toBe(PENDING);
  });

  it('counts the approved accounts alongside the total', () => {
    expect(summariseLiquidations([APPROVED, PENDING, APPROVED])).toEqual({
      liquidationStatus: PENDING,
      liquidationAccounts: 3,
      liquidationsApproved: 2,
    });
  });

  it('is approved only when every account is', () => {
    expect(summariseLiquidations([APPROVED, APPROVED]).liquidationStatus).toBe(APPROVED);
  });
});
