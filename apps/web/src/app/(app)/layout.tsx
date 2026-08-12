import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

/**
 * Everything under this group requires a session. `AppShell` resolves the user
 * from the API and redirects to /login when there is none.
 */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
