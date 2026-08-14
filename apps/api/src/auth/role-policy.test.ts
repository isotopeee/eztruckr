import { UserRole } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';
import {
  ANY_SIGNED_IN_ROLE,
  CAN_ADMINISTER,
  CAN_DECIDE_LIQUIDATION,
  CAN_READ_LIQUIDATION_REFERENCE_DATA,
  CAN_READ_MASTER_DATA,
  CAN_READ_SHIPMENTS,
  CAN_SUBMIT_LIQUIDATION,
  CAN_WRITE_PAYEES,
  CAN_TRANSITION_SHIPMENTS,
  CAN_WRITE_FINANCIAL_MASTER_DATA,
  CAN_WRITE_OPERATIONAL_MASTER_DATA,
  CAN_WRITE_SHIPMENT_MONEY,
  CAN_WRITE_SHIPMENTS,
  ROLES_BY_TRANSITION,
} from './role-policy';
import { ShipmentStatus } from '@eztruckr/types';

/**
 * The policy is declared as data, so it can be asserted as data.
 *
 * These are not tests of the guard — `guards.test.ts` covers that the guard
 * reads a list and fails closed. What is worth pinning here is the CONTENT of
 * two of those lists, because one of them encodes a segregation of duties that
 * is invisible unless you know a dispatch manager holds cash.
 */

const may = (bundle: readonly UserRole[], role: UserRole) => bundle.includes(role);

describe('a dispatch manager dispatches trips and accounts for their own float', () => {
  it('may do the dispatch half', () => {
    expect(may(CAN_READ_SHIPMENTS, UserRole.DISPATCH_MANAGER)).toBe(true);
    expect(may(CAN_READ_MASTER_DATA, UserRole.DISPATCH_MANAGER)).toBe(true);
    expect(may(CAN_WRITE_SHIPMENTS, UserRole.DISPATCH_MANAGER)).toBe(true);
    expect(may(CAN_TRANSITION_SHIPMENTS, UserRole.DISPATCH_MANAGER)).toBe(true);
    expect(may(ANY_SIGNED_IN_ROLE, UserRole.DISPATCH_MANAGER)).toBe(true);
  });

  it('may account for the cash it holds', () => {
    // The reason they are in this list is the reason CREW is: they have their
    // own accounts to explain, not somebody else's to type in.
    expect(may(CAN_SUBMIT_LIQUIDATION, UserRole.DISPATCH_MANAGER)).toBe(true);
  });

  /**
   * THE CONTROL. A dispatch manager is a liquidation custodian, so releasing
   * cash would let them pay themselves and approving would let them sign off
   * their own float. Both lists are the same list, which is what makes one edit
   * enough — and what makes this test worth having when somebody decides the
   * dispatcher "obviously" needs to approve things to get their job done.
   */
  it('may NOT approve a liquidation or release cash — it would be their own', () => {
    expect(may(CAN_DECIDE_LIQUIDATION, UserRole.DISPATCH_MANAGER)).toBe(false);
    expect(may(CAN_WRITE_SHIPMENT_MONEY, UserRole.DISPATCH_MANAGER)).toBe(false);
  });

  it('may not close a trip, which asserts the money is settled', () => {
    // Asserted present rather than defaulted: a transition with no role list at
    // all would pass a "may not" check for entirely the wrong reason.
    const rolesFor = (status: ShipmentStatus): readonly UserRole[] => {
      const roles = ROLES_BY_TRANSITION[status];
      expect(roles, `no role list declared for status ${status}`).toBeDefined();
      return roles ?? [];
    };

    expect(may(rolesFor(ShipmentStatus.CLOSED), UserRole.DISPATCH_MANAGER)).toBe(false);

    // But may drive it as far as delivered, which is dispatch's job.
    for (const status of [
      ShipmentStatus.DISPATCHED,
      ShipmentStatus.IN_TRANSIT,
      ShipmentStatus.DELIVERED,
    ]) {
      expect(may(rolesFor(status), UserRole.DISPATCH_MANAGER)).toBe(true);
    }
  });

  it('may not edit master data, or administer', () => {
    expect(may(CAN_WRITE_OPERATIONAL_MASTER_DATA, UserRole.DISPATCH_MANAGER)).toBe(false);
    expect(may(CAN_WRITE_FINANCIAL_MASTER_DATA, UserRole.DISPATCH_MANAGER)).toBe(false);
    expect(may(CAN_ADMINISTER, UserRole.DISPATCH_MANAGER)).toBe(false);
  });
});

/**
 * What a CREW session may reach, pinned as data.
 *
 * This moved four times in one session — the base only, then the amount
 * without its arithmetic, then nothing — and each move was a role list or a
 * redactor changing with nothing asserting the result. These are the two facts
 * the whole crew portal rests on, and both are one careless import away from
 * silently widening.
 */
describe('a crew session sees their trips and their cash, and no money figures', () => {
  /**
   * `CAN_READ_SHIPMENTS` is what gates `/commissions` and `/crew-pay` now that
   * `UserRole.CREW` was removed from both routes. If CREW appears in this
   * bundle, those routes open up again — and they return EVERY crew member's
   * pay on the trip, not just the caller's, because the filters that used to
   * narrow them were deleted along with the role.
   */
  it('is not in CAN_READ_SHIPMENTS, which is what closes the pay routes', () => {
    expect(may(CAN_READ_SHIPMENTS, UserRole.CREW)).toBe(false);
  });

  /**
   * Crew reach their own trips through an explicit `UserRole.CREW` on the
   * shipment routes plus `scopeToCaller`, never through this bundle. Adding
   * CREW here to "fix" a 403 would hand them every trip in the table.
   */
  it('reads master data only through the narrow liquidation bundle', () => {
    expect(may(CAN_READ_MASTER_DATA, UserRole.CREW)).toBe(false);
    expect(may(CAN_READ_LIQUIDATION_REFERENCE_DATA, UserRole.CREW)).toBe(true);

    // The narrow bundle is the wide one plus CREW, and nothing else — so a role
    // added to CAN_READ_MASTER_DATA cannot be quietly dropped from this one.
    expect([...CAN_READ_LIQUIDATION_REFERENCE_DATA]).toEqual([
      ...CAN_READ_MASTER_DATA,
      UserRole.CREW,
    ]);
  });

  it('may still account for the cash it holds', () => {
    expect(may(CAN_SUBMIT_LIQUIDATION, UserRole.CREW)).toBe(true);
    // But never decide on it — a custodian approving their own float.
    expect(may(CAN_DECIDE_LIQUIDATION, UserRole.CREW)).toBe(false);
  });

  it('may not write payees, only read them', () => {
    expect(may(CAN_WRITE_PAYEES, UserRole.CREW)).toBe(false);
  });
});

describe('the money lists stay accounting’s', () => {
  it('admits exactly ADMINISTRATOR and ACCOUNTING, and nobody who holds cash', () => {
    expect([...CAN_WRITE_SHIPMENT_MONEY]).toEqual([UserRole.ADMINISTRATOR, UserRole.ACCOUNTING]);

    // Everybody who can be a custodian, and therefore must not decide.
    for (const role of [UserRole.CREW, UserRole.DISPATCH_MANAGER]) {
      expect(may(CAN_DECIDE_LIQUIDATION, role)).toBe(false);
    }
  });
});
