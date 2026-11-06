import { defineCodeSet } from './code-set';

/**
 * Access role. Stored as `user.role` SMALLINT.
 *
 * These are NOT ranked: ACCOUNTING is not "more" than DISPATCHER, it is a
 * different job. Never compare roles with `<` or `>`; check membership.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 *
 * 2 IS RETIRED. It was OPERATIONS ("Operations / Dispatcher"); its logins were
 * moved to DISPATCHER by migration `20261012090000_retire_operations_role`,
 * and the database CHECK no longer admits it. Never hand 2 to a new role.
 */
export const UserRole = {
  ADMINISTRATOR: 1,
  ACCOUNTING: 3,
  MANAGEMENT: 4,
  CREW: 5,
  /**
   * The dispatcher's supervisor, and the one who books and dispatches trips and
   * keeps the operational master data. They hold cash floats too, so they are
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
  /**
   * Reads every trip and its balance, carries a float of their own, and adds a
   * trip's billable expenses and additional charges for accounting to approve.
   * Books, dispatches and edits nothing else, keeps no master data and records
   * no payment. See `role-policy.ts`.
   *
   * Linked to a `staff` row because they hold cash, and — unlike the dispatch
   * manager — they see ONLY their own float: no other account on the trip, no
   * allowance requests, no gas deduction, gross profit or commission base.
   */
  DISPATCHER: 7,
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

const meta = defineCodeSet('UserRole', UserRole);

export const USER_ROLE_CODES = meta.codes;
export const isUserRole = meta.isValid;
export const userRoleSchema = meta.schema;

export const USER_ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  [UserRole.ADMINISTRATOR]: 'Administrator',
  [UserRole.ACCOUNTING]: 'Accounting / Finance',
  [UserRole.MANAGEMENT]: 'Management',
  [UserRole.CREW]: 'Crew member',
  [UserRole.DISPATCH_MANAGER]: 'Dispatch manager',
  [UserRole.DISPATCHER]: 'Dispatcher',
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
  UserRole.DISPATCH_MANAGER,
  UserRole.DISPATCHER,
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
  UserRole.DISPATCH_MANAGER,
  UserRole.DISPATCHER,
];

/**
 * Roles that may not even SEE a float that is not theirs.
 *
 * Narrower than `ROLES_CONFINED_TO_THEIR_OWN_FLOAT`, which is about writing: a
 * dispatch manager may edit only their own account but reads every account on
 * the trip, because they run it. A crew member and a dispatcher read only the
 * accounts they are custodian of.
 *
 * THE TRIP ITSELF IS A DIFFERENT QUESTION. Crew see only trips they worked; a
 * dispatcher sees every trip. Only the cash on it is narrowed.
 */
export const ROLES_THAT_SEE_ONLY_THEIR_OWN_FLOAT: readonly UserRole[] = [
  UserRole.CREW,
  UserRole.DISPATCHER,
];

export function seesOnlyOwnFloat(role: UserRole): boolean {
  return ROLES_THAT_SEE_ONLY_THEIR_OWN_FLOAT.includes(role);
}

export function isConfinedToTheirOwnFloat(role: UserRole): boolean {
  return ROLES_CONFINED_TO_THEIR_OWN_FLOAT.includes(role);
}
