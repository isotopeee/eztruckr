import { ForbiddenException } from '@nestjs/common';
import { UserRole, type Page, type Shipment } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';
import type { RequestUser } from '../auth/request-user';
import type { AdjustmentsService } from '../commission/adjustments.service';
import type { CommissionService } from '../commission/commission.service';
import type { GrossProfitService } from './gross-profit.service';
import type { ShipmentsService } from './shipments.service';
import { ShipmentsController } from './shipments.controller';

/**
 * What a crew session is served for a trip's money: nothing.
 *
 * These assertions are about the REDACTION, not the role lists —
 * `role-policy.test.ts` pins which bundles admit CREW. What is pinned here is
 * that the fields actually come back null, because the rule moved three times
 * in one session (the base only, then the amount without its arithmetic, then
 * nothing) and each move was a hand-edited object literal that nothing checked.
 *
 * Deliberately NOT a database test. The redaction is a pure function of the
 * response and the session, so a real Postgres would only slow down the one
 * thing worth asserting — and would tie a security check to a container being
 * up. The services are stubbed to the two calls the controller makes.
 */

const CREW_STAFF_ID = '019ffad1-32fb-7b2f-852d-57bfae9a7802';

/**
 * Every figure the redaction is supposed to remove, in one place.
 *
 * A test that listed them inline would pass for a field somebody forgot to add
 * to the redactor, because the assertion and the implementation would have been
 * written from the same incomplete memory. This is the list the business cares
 * about, stated once.
 */
const MONEY_FIELDS = [
  'grossRate',
  'tpcAmount',
  'netRate',
  'appliedTpcRate',
  'commissionableCharges',
  'grossForCommission',
  'gasDeductionAmount',
  'appliedGasDeductionRate',
  'gasRateOverride',
  'gasRateOverrideReason',
  'commissionableBase',
] as const satisfies readonly (keyof Shipment)[];

function shipmentFixture(): Shipment {
  // Cast once: the controller reads only the crew slots and the money fields,
  // and spelling out forty unrelated columns would bury what is under test.
  return {
    id: '019ffad5-6058-775a-8de1-a009d971c8ad',
    shipmentNumber: '20260813002',
    driverId: 'someone-else',
    helperId: CREW_STAFF_ID,
    clientName: 'Northport Logistics Inc.',

    grossRate: '40000',
    tpcAmount: '5000',
    netRate: '35000',
    appliedTpcRate: '0.1250',
    commissionableCharges: '1000',
    grossForCommission: '36000',
    gasDeductionAmount: '6000',
    appliedGasDeductionRate: '0.2500',
    gasRateOverride: '0.3000',
    gasRateOverrideReason: 'long haul',
    commissionableBase: '30000',
  } as unknown as Shipment;
}

function controllerFor(shipment: Shipment) {
  const shipments = {
    get: () => Promise.resolve(shipment),
    list: () =>
      Promise.resolve({ items: [shipment], total: 1, page: 1, pageSize: 25 } as Page<Shipment>),
  } as unknown as ShipmentsService;

  return new ShipmentsController(
    shipments,
    {} as CommissionService,
    {} as GrossProfitService,
    {} as AdjustmentsService,
  );
}

const crew: RequestUser = {
  id: 'user-crew',
  email: 'joel.bautista@eztruckr.ph',
  name: 'Joel Bautista',
  role: UserRole.CREW,
  isActive: true,
  staffId: CREW_STAFF_ID,
};

const accounting: RequestUser = { ...crew, role: UserRole.ACCOUNTING, staffId: null };

describe('a crew session is served no money figures for a trip', () => {
  it('nulls every one of them on the detail', async () => {
    const shipment = await controllerFor(shipmentFixture()).get('any', crew);

    for (const field of MONEY_FIELDS) {
      expect(shipment[field], `${field} was not redacted`).toBeNull();
    }
  });

  /**
   * The list carries the rate chain too. Redacting only the detail would leave
   * the same figures one screen earlier, which is how a redaction passes review
   * and leaks anyway.
   */
  it('nulls them on the list as well', async () => {
    const page = await controllerFor(shipmentFixture()).list({} as never, crew);

    expect(page.items).toHaveLength(1);
    for (const field of MONEY_FIELDS) {
      expect(page.items[0]?.[field], `${field} leaked through the list`).toBeNull();
    }
  });

  it('leaves everything that is not money alone', async () => {
    const shipment = await controllerFor(shipmentFixture()).get('any', crew);

    expect(shipment.shipmentNumber).toBe('20260813002');
    expect(shipment.clientName).toBe('Northport Logistics Inc.');
    expect(shipment.helperId).toBe(CREW_STAFF_ID);
  });

  it('serves an office session the figures untouched', async () => {
    const shipment = await controllerFor(shipmentFixture()).get('any', accounting);

    expect(shipment.grossRate).toBe('40000');
    expect(shipment.netRate).toBe('35000');
    expect(shipment.commissionableBase).toBe('30000');
  });

  /**
   * Redaction is not the only control on this route — a crew member has no
   * claim to a trip they did not work, and the refusal is deliberately shaped
   * like a missing record rather than a permission error.
   */
  it('refuses a trip the crew member did not work', async () => {
    const other = { ...shipmentFixture(), helperId: 'somebody-else' } as Shipment;

    await expect(controllerFor(other).get('any', crew)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
