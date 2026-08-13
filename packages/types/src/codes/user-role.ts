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
  OPERATIONS: 2,
  ACCOUNTING: 3,
  MANAGEMENT: 4,
  CREW: 5,
  /**
   * Dispatches trips AND holds their cash floats, which is the combination no
   * other role has. They are liquidation custodians, so they deliberately
   * cannot approve a liquidation or release cash — either would let them sign
   * off their own float. See `role-policy.ts`.
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
 * point of having both. A crew login is linked BECAUSE it is scoped — the link
 * is the scope key, and every crew-facing query filters on it. A dispatch
 * manager is linked WITHOUT being scoped: they see every trip like any office
 * user, and the link exists so the system can tell which of the floats out
 * there are theirs to explain.
 *
 * Every other role must have none. An office login that resolved to a person
 * would be silently narrowed to that person's records by any query that
 * filtered on it.
 */
export const ROLES_LINKED_TO_STAFF: readonly UserRole[] = [
  UserRole.CREW,
  UserRole.DISPATCH_MANAGER,
];

export function roleRequiresStaffLink(role: UserRole): boolean {
  return ROLES_LINKED_TO_STAFF.includes(role);
}
