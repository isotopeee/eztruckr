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
  UserRole.DISPATCH_MANAGER,
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
  UserRole.DISPATCH_MANAGER,
] as const;

/** Booking a trip, assigning crew, dispatching: dispatch's job. */
export const CAN_WRITE_SHIPMENTS = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.DISPATCH_MANAGER,
] as const;

/**
 * Charges, the gas rate override, releasing cash, and computing commissions.
 *
 * All of it decides money rather than movement, so it belongs to accounting
 * even though operations owns the trip itself. The gas override in particular
 * moves the commission base for everyone on the shipment.
 *
 * DISPATCH_MANAGER IS ABSENT ON PURPOSE, and this is the one exclusion in this
 * file that is a control rather than a job description. A dispatch manager
 * holds trip cash floats — they are liquidation custodians — so releasing cash
 * would let them pay themselves, and `CAN_DECIDE_LIQUIDATION` below is the same
 * list, so approving would let them sign off their own float. Everything else
 * they do is dispatch, which is why they sit in `CAN_WRITE_SHIPMENTS` instead.
 */
export const CAN_WRITE_SHIPMENT_MONEY = [UserRole.ADMINISTRATOR, UserRole.ACCOUNTING] as const;

/**
 * Submitting a liquidation, and editing the lines that go into it.
 *
 * CREW is in this list and in almost no other: liquidating the trip's cash is
 * the one thing the portal exists for. A crew session is confined to trips it
 * worked, checked against the record rather than the route, so the widened role
 * list does not widen what any individual can reach.
 *
 * DISPATCH_MANAGER is here for the same reason as CREW and not for the office
 * one: they hold floats, so they have their own accounts to explain. What they
 * cannot do is decide any of them — see `CAN_DECIDE_LIQUIDATION`.
 *
 * The office roles are here too because crews call figures in from the road as
 * often as they type them, and `LiquidationHistory` names whoever actually
 * acted — so submitting on someone's behalf is recorded, not disguised.
 */
export const CAN_SUBMIT_LIQUIDATION = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.CREW,
  UserRole.DISPATCH_MANAGER,
] as const;

/**
 * Uploading an attachment.
 *
 * The same list, for the same reason: a receipt photograph is the crew's half
 * of a liquidation. What may be READ back is decided per receipt, against the
 * trip it hangs off.
 */
export const CAN_UPLOAD_RECEIPTS = CAN_SUBMIT_LIQUIDATION;

/**
 * Returning, approving and reversing a liquidation, and settling the variance.
 *
 * All of it is `CAN_WRITE_SHIPMENT_MONEY` — approval posts cost to the P&L and
 * settlement moves cash, which is accounting's call in exactly the way the gas
 * override and the commission computation already are.
 *
 * Deriving this from that list rather than repeating it is what keeps the
 * dispatch manager out of BOTH by one edit: they may submit their float's
 * liquidation and may never be the one who approves it.
 */
export const CAN_DECIDE_LIQUIDATION = CAN_WRITE_SHIPMENT_MONEY;

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
  UserRole.DISPATCH_MANAGER,
] as const;

/** Every signed-in role, for routes about the caller themselves. */
export const ANY_SIGNED_IN_ROLE = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
  UserRole.CREW,
  UserRole.DISPATCH_MANAGER,
] as const;
