'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  SETTLEMENT_STATUS_LABELS,
  USER_ROLE_LABELS,
  UserRole,
  type Page as ApiPage,
} from '@eztruckr/types';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { HealthStatusCard } from '@/components/health-status-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { getOutstandingAllowances, liquidationKeys, listLiquidations } from '@/lib/liquidation-api';
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
        <>
          <OutstandingAllowancesCard />
          <ReturnedForCorrectionCard />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TILES.map((tile) => (
              <CountTile key={tile.key} label={tile.label} href={tile.href} />
            ))}
          </div>
        </>
      )}

      <HealthStatusCard />
    </div>
  );
}

/**
 * Trips whose leftover cash has not come back.
 *
 * READS THE SETTLEMENT STATUS DIRECTLY. Inferring it from the liquidation would
 * answer a different question — whether the spending was accounted for — and
 * would report a trip as clear while the crew still held the change. A carried
 * balance stays on this list until the payout run recovering it is paid.
 */
function OutstandingAllowancesCard() {
  const outstanding = useQuery({
    queryKey: liquidationKeys.outstanding,
    queryFn: getOutstandingAllowances,
  });

  const report = outstanding.data;

  if (!report || report.total === 0) {
    return null;
  }

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Allowances outstanding
        </CardTitle>
        <CardDescription>
          {report.total} trip{report.total === 1 ? '' : 's'} with cash unaccounted for —{' '}
          {formatMoney(report.totalAmount)} in total.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {report.items.map((item) => (
            <li key={item.shipmentId} className="flex items-center justify-between gap-3 py-2">
              <Link
                href={`/shipments/${item.shipmentId}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {item.shipmentNumber}
              </Link>
              <div className="flex items-center gap-2">
                <span className="tabular-nums">{formatMoney(item.amount)}</span>
                <Badge variant="outline">{SETTLEMENT_STATUS_LABELS[item.status]}</Badge>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Liquidations sent back to the crew.
 *
 * The filter is `returnedOnly`, which the API resolves as PENDING with prior
 * history. There is no returned status to ask for, and that is deliberate — see
 * the code set. Asking for the flag rather than assembling the condition here
 * keeps one definition of what "returned" means.
 */
function ReturnedForCorrectionCard() {
  const returned = useQuery({
    queryKey: liquidationKeys.list('returned'),
    queryFn: () => listLiquidations({ returnedOnly: true }),
  });

  const rows = returned.data ?? [];

  if (rows.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Undo2 className="text-muted-foreground h-4 w-4" />
          Returned for correction
        </CardTitle>
        <CardDescription>Back with the crew after being sent back at least once.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {rows.map((liquidation) => (
            <li key={liquidation.id} className="space-y-1 py-2">
              <Link
                href={`/shipments/${liquidation.shipmentId}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {liquidation.shipmentNumber ?? 'Trip'}
              </Link>
              {liquidation.latestReturnReason ? (
                <p className="text-muted-foreground text-xs">{liquidation.latestReturnReason}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
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
