'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { USER_ROLE_LABELS } from '@eztruckr/types';
import { Loader2, LogOut, Menu, Truck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth-client';
import { visibleSections } from '@/lib/nav';
import { useCurrentUser } from '@/lib/use-current-user';
import { cn } from '@/lib/utils';

/**
 * The authenticated frame: role-aware navigation plus who you are signed in as.
 *
 * Redirection lives here rather than in middleware because the session is
 * held by the API on another origin — the Next server cannot see the cookie,
 * so "am I signed in" is a question only the browser can ask, by calling
 * /api/me. That call is the single source of truth for both the redirect and
 * the navigation.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    );
  }

  if (!user) {
    router.replace('/login');
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">Redirecting to sign in…</p>
      </div>
    );
  }

  const sections = visibleSections(user.role);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    // The cached /me answer is now wrong, and leaving it would let the next
    // render briefly show a signed-in shell to a signed-out user.
    queryClient.clear();
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-background sticky top-0 z-20 border-b">
        <div className="flex h-14 items-center gap-3 px-4">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Toggle navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Menu className="size-5" />
          </Button>

          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Truck className="size-5" />
            EZTruckr
          </Link>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm leading-tight font-medium">{user.displayName ?? user.name}</p>
              <p className="text-muted-foreground text-xs leading-tight">{user.email}</p>
            </div>
            <Badge variant="secondary">{USER_ROLE_LABELS[user.role]}</Badge>
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={handleSignOut}>
              {signingOut ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          className={cn(
            'bg-muted/30 w-56 shrink-0 border-r p-4 md:block',
            menuOpen ? 'block' : 'hidden',
          )}
        >
          {sections.map((section) => (
            <div key={section.title} className="mb-6">
              <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                {section.title}
              </p>
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const isActive =
                    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMenuOpen(false)}
                        className={cn(
                          'block rounded-md px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground font-medium'
                            : 'hover:bg-accent',
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
