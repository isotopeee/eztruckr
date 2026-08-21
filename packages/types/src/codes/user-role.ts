import { defineCodeSet } from './code-set';

/**
 * Access role. Stored as `user.role` SMALLINT.
 *
 * These are NOT ranked: ACCOUNTING is not "more" than OPERATIONS, it is a
 * different job. Never compare roles with `<` or `>`; check membership.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const UserRole = {
  ADMINISTRATOR: 1,
  /**
   * The dispatcher. Books trips, assigns crew, moves them down the road, and
   * carries a float of their own — so their login names a `staff` row and
   * their liquidation work is confined to accounts they are custodian of.
   *
   * They keep no master data beyond routes: the fleet, the client and broker
   * directories and the payee list belong to their manager. That is a
   * deliberate narrowing of what this role used to be.
   */
  OPERATIONS: 2,
  ACCOUNTING: 3,
  MANAGEMENT: 4,
  CREW: 5,
  /**
   * The dispatcher's supervisor: everything OPERATIONS may do, plus the master
   * data a dispatcher may not keep. They hold cash floats too, so they are
   * liquidation custodians and deliberately cannot approve a liquidation or
   * release cash — either would let them sign off their own float. See
   * `role-policy.ts`.
   *
   * THEY DO RECORD WHAT CLIENTS PAY, which is not a hole in that control and is
   * worth saying because it looks like one. The float rule keeps them away from
   * money going OUT to the crew, where they are a recipient; a client's payment
   * comes IN, reaches nobody's pocket, and is checked by accounting before it
   * is treated as confirmed. See `CAN_RECORD_CLIENT_PAYMENT`.
   */
  DISPATCH_MANAGER: 6,
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

const meta = defineCodeSet('UserRole', UserRole);

export const USER_ROLE_CODES = meta.codes;
export const isUserRole = meta.isValid;
export const userRoleSchema = meta.schema;

export const USER_ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  [UserRole.ADMINISTRATOR]: 'Administrator',
  [UserRole.OPERATIONS]: 'Operations / Dispatcher',
  [UserRole.ACCOUNTING]: 'Accounting / Finance',
  [UserRole.MANAGEMENT]: 'Management',
  [UserRole.CREW]: 'Crew member',
  [UserRole.DISPATCH_MANAGER]: 'Dispatch manager',
};

/**
 * Roles whose access is confined to the crew portal and scoped to their own
 * records. Crew scoping is a hard server-side requirement, so this is stated
 * once here rather than re-derived at each call site.
 */
export const PORTAL_ONLY_ROLES: readonly UserRole[] = [UserRole.CREW];

export function isPortalOnlyRole(role: UserRole): boolean {
  return PORTAL_ONLY_ROLES.includes(role);
}

/**
 * Roles whose login must name the `staff` row it belongs to.
 *
 * NOT the same list as `PORTAL_ONLY_ROLES`, and the difference is the whole
 * point of having both. A crew login is linked BECAUSE it is confined to the
 * portal — the link is the scope key, and every crew-facing query filters on
 * it. A dispatcher and a dispatch manager see every trip like any office user;
 * they are linked so the system can tell which of the floats out there are
 * theirs to explain.
 *
 * EVERY ROLE HERE HOLDS TRIP CASH, and that is the rule the list encodes.
 * Accounting release it and management read about it, but neither is ever
 * answerable for a float, so neither resolves to a person. An office login that
 * resolved to a person without needing to would be silently narrowed to that
 * person's records by any query that filtered on it.
 */
export const ROLES_LINKED_TO_STAFF: readonly UserRole[] = [
  UserRole.CREW,
  UserRole.OPERATIONS,
  UserRole.DISPATCH_MANAGER,
];

export function roleRequiresStaffLink(role: UserRole): boolean {
  return ROLES_LINKED_TO_STAFF.includes(role);
}

/**
 * Roles whose liquidation work is confined to the accounts they are custodian
 * of.
 *
 * The same membership as `ROLES_LINKED_TO_STAFF` today, and deliberately a
 * SEPARATE list rather than an alias: the two answer different questions and
 * have already disagreed once. A dispatch manager was linked without being
 * confined — they carried a staff row only so their floats could be told apart,
 * and could edit anybody's account. Merging the lists then would have been
 * correct by accident and wrong the moment either rule moved.
 *
 * The office roles that are absent — ADMINISTRATOR and ACCOUNTING — are the
 * ones who may act on somebody else's account, because a crew calling figures
 * in from the road has to reach someone who can type them, and
 * `LiquidationHistory` names whoever actually did.
 */
export const ROLES_CONFINED_TO_THEIR_OWN_FLOAT: readonly UserRole[] = [
  UserRole.CREW,
  UserRole.OPERATIONS,
  UserRole.DISPATCH_MANAGER,
];

export function isConfinedToTheirOwnFloat(role: UserRole): boolean {
  return ROLES_CONFINED_TO_THEIR_OWN_FLOAT.includes(role);
}
