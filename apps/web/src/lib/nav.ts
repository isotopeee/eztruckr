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

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Overview',
    items: [
      {
        href: '/',
        label: 'Dashboard',
        roles: [...OFFICE_ROLES, UserRole.CREW],
      },
      { href: '/my-record', label: 'My record', roles: [UserRole.CREW] },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/trucks', label: 'Trucks', roles: OFFICE_ROLES },
      { href: '/crew-members', label: 'Crew members', roles: OFFICE_ROLES },
      { href: '/clients', label: 'Clients', roles: OFFICE_ROLES },
      { href: '/third-parties', label: 'Third parties', roles: OFFICE_ROLES },
      { href: '/routes', label: 'Routes', roles: OFFICE_ROLES },
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
