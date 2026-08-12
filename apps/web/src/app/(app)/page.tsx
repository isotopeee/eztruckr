'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { USER_ROLE_LABELS, UserRole, type Page as ApiPage } from '@eztruckr/types';
import { HealthStatusCard } from '@/components/health-status-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';

/** The counts an office user can actually see, keyed to a screen they can open. */
const TILES = [
  { key: 'trucks', label: 'Trucks', href: '/trucks' },
  { key: 'crew-members', label: 'Crew members', href: '/crew-members' },
  { key: 'clients', label: 'Clients', href: '/clients' },
  { key: 'routes', label: 'Routes', href: '/routes' },
] as const;

export default function DashboardPage() {
  const { user } = useCurrentUser();
  const isCrew = user?.role === UserRole.CREW;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {user ? `Welcome, ${user.displayName ?? user.name}` : 'Dashboard'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {user ? `Signed in as ${USER_ROLE_LABELS[user.role]}.` : null}
        </p>
      </header>

      {isCrew ? (
        <Card>
          <CardHeader>
            <CardTitle>Your portal</CardTitle>
            <CardDescription>
              Crew accounts see only their own records. Trips, allowances and payouts arrive in a
              later phase.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/my-record" className="text-sm underline underline-offset-4">
              View my crew record
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TILES.map((tile) => (
            <CountTile key={tile.key} label={tile.label} href={tile.href} />
          ))}
        </div>
      )}

      <HealthStatusCard />
    </div>
  );
}

function CountTile({ label, href }: { label: string; href: string }) {
  const { data } = useQuery({
    queryKey: ['count', href],
    // pageSize=1 because only `total` is wanted — pulling a full page to count
    // it would be a page of rows nobody renders.
    queryFn: () => apiFetch<ApiPage<unknown>>(`${href}?pageSize=1`),
  });

  return (
    <Link href={href}>
      <Card className="hover:border-primary transition-colors">
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{data?.total ?? '—'}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-xs">Active records</p>
        </CardContent>
      </Card>
    </Link>
  );
}
