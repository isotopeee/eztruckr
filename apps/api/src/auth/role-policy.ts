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
 * The two reference lists a CREW session needs to file a liquidation, and
 * nothing else.
 *
 * A crew member picks an expense category and a payee for every line they
 * claim. Both endpoints sat behind `CAN_READ_MASTER_DATA`, which deliberately
 * excludes CREW — so the pickers came back empty and the crew portal could not
 * record an expense at all. It looked like a disabled dropdown; it was a 403.
 *
 * Widening `CAN_READ_MASTER_DATA` would have fixed it by also handing crew the
 * truck list, the client list, the broker list and every colleague's staff
 * record. This bundle is the narrow answer: exactly the two lists the form
 * needs, still read-only, and named so that adding a third is a decision.
 */
export const CAN_READ_LIQUIDATION_REFERENCE_DATA = [
  ...CAN_READ_MASTER_DATA,
  UserRole.CREW,
] as const;

/**
 * The fleet and the counterparty directories: trucks, clients, brokers.
 *
 * OPERATIONS USED TO BE HERE AND IS NOT ANY MORE. A dispatcher books trips
 * against these lists all day and still may not edit them: adding a client is
 * how a duplicate client appears, and the broker directory carries the default
 * cut that seeds a rate chain. Keeping the trip and the directory it is booked
 * against in different hands is the point — the dispatcher's own supervisor is
 * the nearest person who can add one, not an accountant two floors away.
 *
 * Reading is untouched and stays `CAN_READ_MASTER_DATA`, because every one of
 * these is a picker on the booking form.
 */
export const CAN_WRITE_OPERATIONAL_MASTER_DATA = [
  UserRole.ADMINISTRATOR,
  UserRole.DISPATCH_MANAGER,
] as const;

/**
 * Routes, which a dispatcher does keep.
 *
 * The one list above that describes the company's own operation rather than
 * somebody outside it: a lane discovered on a Tuesday is dispatch's to record,
 * and its standard rate and allowance only ever prefill a form — every figure
 * that matters is frozen onto the shipment.
 */
export const CAN_WRITE_ROUTES = [
  ...CAN_WRITE_OPERATIONAL_MASTER_DATA,
  UserRole.OPERATIONS,
] as const;

/**
 * The staff directory: the administrator alone.
 *
 * NARROWER THAN EVERYTHING ELSE, because this table decides two things no
 * other master data does. `eligibleRoles` says who may be handed a trip's cash
 * — so anyone who could edit it could make themselves a custodian — and a
 * `staff` row is what a login is linked to, which is how a session resolves to
 * a person. Dispatch reads it constantly, to fill a driver slot; neither the
 * dispatcher nor their manager writes to it.
 */
export const CAN_WRITE_STAFF = [UserRole.ADMINISTRATOR] as const;

/**
 * Expense categories and commission rules decide how money is classified and
 * what crew are paid, so they belong to accounting rather than dispatch.
 */
export const CAN_WRITE_FINANCIAL_MASTER_DATA = [
  UserRole.ADMINISTRATOR,
  UserRole.ACCOUNTING,
] as const;

/**
 * Payees, which fit neither bundle above and so get their own.
 *
 * Dispatch must be able to add one mid-task: a driver fuels at a station
 * nobody has recorded before, and whoever types that liquidation line cannot
 * be sent to find an accountant first — a directory you may not extend while
 * using it gets worked around with a blank field. Accounting must be able to
 * edit one because the address and TIN are what a voucher and a BIR form are
 * built from, and those are not dispatch's to get right.
 *
 * THE DISPATCH HALF IS THE MANAGER, NOT THE DISPATCHER, which is a narrowing
 * and does cost something: a dispatcher typing their own liquidation against a
 * station nobody has recorded has to ask for it. That was the deliberate call —
 * a payee is who money is disbursed to, and the person claiming the expense
 * should not also be the person who invented the recipient. Management stays
 * out: they record no disbursement at all.
 */
export const CAN_WRITE_PAYEES = [
  UserRole.ADMINISTRATOR,
  UserRole.ACCOUNTING,
  UserRole.DISPATCH_MANAGER,
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
 * BOTH DISPATCH ROLES ARE ABSENT ON PURPOSE, and this is the one exclusion in
 * this file that is a control rather than a job description. A dispatcher and a
 * dispatch manager both hold trip cash floats — they are liquidation custodians
 * — so releasing cash would let them pay themselves, and
 * `CAN_DECIDE_LIQUIDATION` below is the same list, so approving would let them
 * sign off their own float. Everything else they do is dispatch, which is why
 * they sit in `CAN_WRITE_SHIPMENTS` instead.
 */
export const CAN_WRITE_SHIPMENT_MONEY = [UserRole.ADMINISTRATOR, UserRole.ACCOUNTING] as const;

/**
 * Correcting the gross rate or the broker cut after the trip has left DRAFT.
 *
 * A SEPARATE LIST FROM BOTH ITS NEIGHBOURS, and it has to be. The rate chain
 * is not `CAN_WRITE_SHIPMENT_MONEY`: it is the figure agreed with the client
 * when the trip was sold, and the people who negotiate it are the ones running
 * dispatch, not the ones deciding what to pay out against it. Nor is it
 * `CAN_WRITE_SHIPMENTS`, which is every dispatcher — a gross rate moves the
 * commission base for everyone on the trip, so correcting one after the crew
 * are on the road is the supervisor's call.
 *
 * WHAT STOPS THIS BEING A BACK DOOR is not the role list, it is the guard the
 * service applies underneath: the correction is refused once the trip is
 * liquidated or any commission has been PAID, exactly as a late charge is.
 * Commissions computed but unpaid go stale and are recomputed. Anyone who
 * widens this list should read `assertNothingPaid` first — that is the line
 * that matters, and it does not move.
 */
export const CAN_EDIT_RATE_CHAIN = [UserRole.ADMINISTRATOR, UserRole.DISPATCH_MANAGER] as const;

/**
 * Submitting a liquidation, and editing the lines that go into it.
 *
 * CREW is in this list and in almost no other: liquidating the trip's cash is
 * the one thing the portal exists for. A crew session is confined to trips it
 * worked, checked against the record rather than the route, so the widened role
 * list does not widen what any individual can reach.
 *
 * OPERATIONS and DISPATCH_MANAGER are here for the same reason as CREW and not
 * for the office one: they hold floats, so they have their own accounts to
 * explain. Being in this list does NOT let them touch anybody else's — all
 * three are in `ROLES_CONFINED_TO_THEIR_OWN_FLOAT`, and the service checks
 * custodianship on every one of these methods. What none of them can do is
 * decide an account — see `CAN_DECIDE_LIQUIDATION`.
 *
 * ADMINISTRATOR and ACCOUNTING are here for the office reason, and are the only
 * two who may act on an account that is not theirs: crews call figures in from
 * the road as often as they type them, and `LiquidationHistory` names whoever
 * actually acted — so submitting on someone's behalf is recorded, not
 * disguised.
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
