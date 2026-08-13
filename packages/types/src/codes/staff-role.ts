import { defineCodeSet } from './code-set';

/**
 * What a member of staff MAY be engaged as. Stored in `staff.eligibleRoles` as
 * a SMALLINT array, with a CHECK requiring every element to be a valid code.
 *
 * THE SUPERSET, of which `CrewRole` is the part that rides on a truck. The two
 * were one set while `staff` was `crew_member` and everyone in it was crew.
 * Dispatch managers broke that: they hold a trip's cash and are answerable for
 * accounting for it, but they do not drive, do not help, and — for now — earn
 * no commission.
 *
 * `CrewRole` is DERIVED from this rather than repeating its values, which is
 * what stops the two drifting into disagreeing about what a 1 means. Everything
 * downstream of a commission keys on `CrewRole`, so a dispatch manager cannot
 * reach the commission engine by construction, and `commission_role_code_valid`
 * still says `IN (1, 2)` in the database.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const StaffRole = {
  DRIVER: 1,
  HELPER: 2,
  DISPATCH_MANAGER: 3,
} as const;

export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole];

const meta = defineCodeSet('StaffRole', StaffRole);

export const STAFF_ROLE_CODES = meta.codes;
export const isStaffRole = meta.isValid;
export const staffRoleSchema = meta.schema;

export const STAFF_ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  [StaffRole.DRIVER]: 'Driver',
  [StaffRole.HELPER]: 'Helper',
  [StaffRole.DISPATCH_MANAGER]: 'Dispatch manager',
};

/**
 * Roles that put somebody on a truck, and therefore in line for a commission.
 *
 * Declared here, next to the superset, so "which roles are crew roles" is
 * answered in one place rather than by each caller listing two of them.
 */
export const CREW_STAFF_ROLES: readonly StaffRole[] = [StaffRole.DRIVER, StaffRole.HELPER];

/**
 * Somebody who may be handed a trip's cash and made answerable for it without
 * being on the truck.
 *
 * A predicate rather than a bare comparison because three separate guards ask
 * it — who may be custodian, who may receive a release, whose pay a carried
 * balance may be charged to — and this codebase's recurring defect is a guard
 * copied without its reason.
 */
export function mayHoldTripCashWithoutASlot(eligibleRoles: readonly number[]): boolean {
  return eligibleRoles.includes(StaffRole.DISPATCH_MANAGER);
}
