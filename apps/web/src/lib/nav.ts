import { UserRole } from '@eztruckr/types';

/**
 * Navigation, filtered by role.
 *
 * Hiding a link is a courtesy, not a control — every one of these routes is
 * enforced server-side by `RolesGuard`, and a crew member who types /trucks
 * gets a 403 whether or not the link was rendered. The point here is that
 * someone should not be shown a door they cannot open.
 */
export interface NavItem {
  href: string;
  label: string;
  roles: readonly UserRole[];
}

const OFFICE_ROLES = [
  UserRole.ADMINISTRATOR,
  UserRole.OPERATIONS,
  UserRole.ACCOUNTING,
  UserRole.MANAGEMENT,
] as const;

/**
 * Office roles plus the dispatch manager, who works trips rather than books.
 *
 * A separate bundle rather than an addition to `OFFICE_ROLES`, because the
 * dispatch manager is deliberately absent from the Finance and Administration
 * sections: they may not write commission rules or expense categories, and the
 * server refuses either way. Showing them a door they cannot open is exactly
 * what this file exists to avoid.
 */
const OPERATIONAL_ROLES = [...OFFICE_ROLES, UserRole.DISPATCH_MANAGER] as const;

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Overview',
    items: [
      {
        href: '/',
        label: 'Dashboard',
        roles: [...OPERATIONAL_ROLES, UserRole.CREW],
      },
      // Both linked roles have a staff row to show. A dispatch manager is not
      // scoped by the link, but it still names the person they are.
      {
        href: '/my-record',
        label: 'My record',
        roles: [UserRole.CREW, UserRole.DISPATCH_MANAGER],
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      // Crew see this too: it is their own trip list, scoped server-side to
      // the shipments they actually worked.
      { href: '/shipments', label: 'Shipments', roles: [...OPERATIONAL_ROLES, UserRole.CREW] },
      { href: '/trucks', label: 'Trucks', roles: OPERATIONAL_ROLES },
      { href: '/staff', label: 'Staff', roles: OPERATIONAL_ROLES },
      { href: '/clients', label: 'Clients', roles: OPERATIONAL_ROLES },
      { href: '/third-parties', label: 'Third parties', roles: OPERATIONAL_ROLES },
      { href: '/routes', label: 'Routes', roles: OPERATIONAL_ROLES },
    ],
  },
  {
    title: 'Finance',
    items: [
      { href: '/expense-categories', label: 'Expense categories', roles: OFFICE_ROLES },
      { href: '/commission-rules', label: 'Commission rules', roles: OFFICE_ROLES },
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
