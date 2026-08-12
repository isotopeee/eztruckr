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
