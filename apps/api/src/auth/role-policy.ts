import { ShipmentStatus, UserRole } from '@eztruckr/types';

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

/**
 * Shipments. Reading is open to every office role, because a trip is the unit
 * everyone's job is organised around.
 */
export const CAN_READ_SHIPMENTS = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
] as const;

/** Booking a trip, assigning crew, dispatching: dispatch's job. */
export const CAN_WRITE_SHIPMENTS = [UserRole.ADMINISTRATOR, UserRole.OPERATIONS] as const;

/**
 * Charges, the gas rate override, and computing commissions.
 *
 * All three decide money rather than movement, so they belong to accounting
 * even though operations owns the trip itself. The gas override in particular
 * moves the commission base for everyone on the shipment.
 */
export const CAN_WRITE_SHIPMENT_MONEY = [UserRole.ADMINISTRATOR, UserRole.ACCOUNTING] as const;

/**
 * Who may drive each status transition.
 *
 * The route-level `@Roles` on the transition endpoint is necessarily the union
 * of these, because the guard cannot see the request body. This map is the
 * real policy and the controller applies it per target status, so that
 * operations cannot close a trip and accounting cannot dispatch one. Declared
 * here rather than inline for the same reason as everything else in this file:
 * a policy scattered across handlers is impossible to audit as a whole.
 */
export const ROLES_BY_TRANSITION: Readonly<Record<number, readonly UserRole[]>> = {
  [ShipmentStatus.DISPATCHED]: CAN_WRITE_SHIPMENTS,
  [ShipmentStatus.IN_TRANSIT]: CAN_WRITE_SHIPMENTS,
  [ShipmentStatus.DELIVERED]: CAN_WRITE_SHIPMENTS,
  // Closing asserts the money is settled, which is accounting's call.
  [ShipmentStatus.CLOSED]: CAN_WRITE_SHIPMENT_MONEY,
};

export const CAN_TRANSITION_SHIPMENTS = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
] as const;

/** Every signed-in role, for routes about the caller themselves. */
export const ANY_SIGNED_IN_ROLE = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
  UserRole.CREW,
] as const;
