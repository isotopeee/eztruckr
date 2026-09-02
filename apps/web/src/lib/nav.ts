import { UserRole } from '@eztruckr/types';

/**
 * Which screens exist, and who may open each one.
 *
 * TWO STRENGTHS OF RULE LIVE HERE, and the difference matters. Hiding a link is
 * a courtesy: every route is enforced server-side by `RolesGuard`, and a crew
 * member who types /trucks gets a 403 whether or not the link was rendered.
 * But a master data screen READS through `CAN_READ_MASTER_DATA`, which is
 * deliberately wide — the booking form needs the client list, the crew picker
 * needs the staff list — so the API will happily serve /trucks to a dispatcher
 * who navigates there by hand. `PAGE_ROLES` is what closes that: `ResourcePage`
 * refuses to render for a role that is not listed, and the same list drives the
 * navigation, so the two cannot disagree.
 *
 * What is NOT weakened by any of it: every write is a role list on the API.
 * A screen this file lets someone open still shows them no buttons they may
 * not press.
 */
export interface NavItem {
  href: string;
  label: string;
  roles: readonly UserRole[];
}

/**
 * The desks that are not dispatch.
 *
 * The company's directories — the fleet, the clients, the brokers, the people —
 * are theirs to keep, and dispatch works against them without editing them.
 * MANAGEMENT and ACCOUNTING read; only the administrator among them writes to
 * all of it.
 */
const OFFICE_BEYOND_DISPATCH = [
  UserRole.ADMINISTRATOR,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
] as const;

/** Everyone who works a trip from a desk, either role. */
const DISPATCH_ROLES = [UserRole.OPERATIONS, UserRole.DISPATCH_MANAGER] as const;

const EVERY_DESK = [...OFFICE_BEYOND_DISPATCH, ...DISPATCH_ROLES] as const;

/**
 * Who may open each master data screen. Imported by `resources.tsx` as well, so
 * the door and the room are the same decision.
 *
 * THE DISPATCHER IS ABSENT FROM ALL BUT ROUTES, which is the narrowing this map
 * was written for: they book trips against these lists all day and keep none of
 * them. Their manager keeps the operational ones — a dispatcher who needs a new
 * client asks the person sitting next to them, not accounting.
 *
 * STAFF IS NARROWER STILL, and neither dispatch role is on it: `eligibleRoles`
 * decides who may be handed a trip's cash, so editing this table is how someone
 * would make themselves a custodian.
 */
export const PAGE_ROLES = {
  trucks: [...OFFICE_BEYOND_DISPATCH, UserRole.DISPATCH_MANAGER],
  staff: OFFICE_BEYOND_DISPATCH,
  clients: [...OFFICE_BEYOND_DISPATCH, UserRole.DISPATCH_MANAGER],
  thirdParties: [...OFFICE_BEYOND_DISPATCH, UserRole.DISPATCH_MANAGER],
  payees: [...OFFICE_BEYOND_DISPATCH, UserRole.DISPATCH_MANAGER],
  // The one list that describes this company's own operation rather than
  // somebody outside it, and the one a dispatcher keeps.
  routes: EVERY_DESK,
  expenseCategories: OFFICE_BEYOND_DISPATCH,
  commissionRules: OFFICE_BEYOND_DISPATCH,
  // NOT a master data screen — a ledger. It is in this map anyway because the
  // question the map answers ("who may open this?") is the same one, and a
  // second list of page roles somewhere else is a second place to forget.
  //
  // The API's read guard, `CAN_READ_OPERATION_EXPENSES`, is exactly these three
  // rather than being wider — so unlike every entry above, this line is a
  // courtesy rather than the thing that closes a hole. Dispatch is refused the
  // overhead ledger by the server whether or not the link is drawn.
  operationExpenses: OFFICE_BEYOND_DISPATCH,
} satisfies Record<string, readonly UserRole[]>;

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Overview',
    items: [
      {
        href: '/',
        label: 'Dashboard',
        roles: [...EVERY_DESK, UserRole.CREW],
      },
      // Every linked role has a staff row to show. The two office ones are not
      // scoped by the link, but it still names the person they are — and it is
      // the row their floats hang off.
      {
        href: '/my-record',
        label: 'My record',
        roles: [UserRole.CREW, ...DISPATCH_ROLES],
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      // Crew see this too: it is their own trip list, scoped server-side to
      // the shipments they actually worked.
      { href: '/shipments', label: 'Shipments', roles: [...EVERY_DESK, UserRole.CREW] },
      { href: '/trucks', label: 'Trucks', roles: PAGE_ROLES.trucks },
      { href: '/staff', label: 'Staff', roles: PAGE_ROLES.staff },
      { href: '/clients', label: 'Clients', roles: PAGE_ROLES.clients },
      { href: '/third-parties', label: 'Third parties', roles: PAGE_ROLES.thirdParties },
      // Directly under Third parties, because the two get mixed up and seeing
      // both named at once is the cheapest correction. Here rather than in
      // Finance because a payee is picked while typing a liquidation.
      { href: '/payees', label: 'Payees', roles: PAGE_ROLES.payees },
      { href: '/routes', label: 'Routes', roles: PAGE_ROLES.routes },
    ],
  },
  {
    title: 'Finance',
    items: [
      {
        href: '/expense-categories',
        label: 'Expense categories',
        roles: PAGE_ROLES.expenseCategories,
      },
      { href: '/commission-rules', label: 'Commission rules', roles: PAGE_ROLES.commissionRules },
      // Under Finance rather than Operations despite the name: this is what it
      // costs to keep the company open, and the desk that reads it is the one
      // that keeps the categories directly above.
      {
        href: '/operation-expenses',
        label: 'Operation expenses',
        roles: PAGE_ROLES.operationExpenses,
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/users', label: 'Users', roles: [UserRole.ADMINISTRATOR] },
      { href: '/settings', label: 'System settings', roles: [UserRole.ADMINISTRATOR] },
    ],
  },
];

export function visibleSections(role: UserRole) {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}
