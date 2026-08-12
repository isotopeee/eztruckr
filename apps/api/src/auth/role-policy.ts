import { UserRole } from '@eztruckr/types';

/**
 * Who may do what, declared once.
 *
 * Spelling these out here rather than repeating role lists across controllers
 * means a policy change is one edit, and — more usefully — that the policy is
 * readable as a whole. Scattered `@Roles(1, 2)` calls are individually
 * obvious and collectively impossible to audit.
 *
 * Roles are a membership test, never a ranking: MANAGEMENT appears in the read
 * bundles and in none of the write ones, which is the point of the job, not a
 * lower rung.
 */

/** Everyone with a desk. Master data has to be readable to be selectable. */
export const CAN_READ_MASTER_DATA = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
] as const;

/**
 * Trucks, crew, clients, brokers, routes — the things dispatch needs to keep
 * current, so operations owns them.
 */
export const CAN_WRITE_OPERATIONAL_MASTER_DATA = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
] as const;

/**
 * Expense categories and commission rules decide how money is classified and
 * what crew are paid, so they belong to accounting rather than dispatch.
 */
export const CAN_WRITE_FINANCIAL_MASTER_DATA = [
  UserRole.ADMINISTRATOR,
  UserRole.ACCOUNTING,
] as const;

/** Creating logins and assigning roles is the administrator's alone. */
export const CAN_ADMINISTER = [UserRole.ADMINISTRATOR] as const;

/** Every signed-in role, for routes about the caller themselves. */
export const ANY_SIGNED_IN_ROLE = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
  UserRole.CREW,
] as const;
