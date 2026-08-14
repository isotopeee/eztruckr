'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  STAFF_ROLE_LABELS,
  LIQUIDATION_STATUS_LABELS,
  LiquidationStatus,
  type Staff,
} from '@eztruckr/types';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { liquidationKeys, listLiquidations } from '@/lib/liquidation-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * The crew portal's one screen for now: your own crew record.
 *
 * The id comes from the session, never from the URL. The API checks it again
 * server-side — a crew login asking for someone else's id gets a 403 — so this
 * is convenience, not the control.
 */
export default function MyRecordPage() {
  const { user } = useCurrentUser();
  const staffId = user?.staffId ?? null;

  const record = useQuery({
    queryKey: ['staff', staffId],
    queryFn: () => apiFetch<Staff>(`/staff/${staffId}`),
    enabled: !!staffId,
  });

  if (!user) return null;

  if (!staffId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No crew record linked</CardTitle>
          <CardDescription>
            This login is not linked to a crew member. An administrator can link it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My record</h1>
        <p className="text-muted-foreground text-sm">
          Contact an administrator to correct anything here.
        </p>
      </header>

      <LiquidationsWaitingCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {record.data ? `${record.data.firstName} ${record.data.lastName}` : 'Crew record'}
            {record.data ? (
              <Badge variant={record.data.isActive ? 'secondary' : 'outline'}>
                {record.data.isActive ? 'Active' : 'Inactive'}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {record.data ? `${record.data.lastName}, ${record.data.firstName}` : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {record.isPending ? (
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          ) : record.isError ? (
            <p className="text-destructive text-sm">
              {record.error instanceof ApiError
                ? record.error.displayMessage
                : 'Could not load your record'}
            </p>
          ) : record.data ? (
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Row label="Eligible as">
                {record.data.eligibleRoles.map((role) => STAFF_ROLE_LABELS[role]).join(', ') || '—'}
              </Row>
              <Row label="Phone">{record.data.phone ?? '—'}</Row>
              <Row label="Email">{record.data.email ?? '—'}</Row>
              <Row label="Address">{record.data.address ?? '—'}</Row>
              <Row label="Date hired">
                {record.data.dateHired ? formatDate(record.data.dateHired) : '—'}
              </Row>
              <Row label="Licence number">{record.data.licenseNumber ?? '—'}</Row>
              <Row label="Licence expiry">
                {record.data.licenseExpiry ? formatDate(record.data.licenseExpiry) : '—'}
              </Row>
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The trips still waiting on this crew member.
 *
 * The list is scoped by the session server-side — there is no query parameter
 * that widens it — so this component asks for "pending liquidations" and gets
 * only its own.
 *
 * The return reason comes from `LiquidationHistory`, which is the whole reason
 * that table exists: a returned liquidation is PENDING, exactly like one never
 * submitted, and without the history the crew would be told to try again with
 * no idea what was wrong.
 */
function LiquidationsWaitingCard() {
  const waiting = useQuery({
    queryKey: liquidationKeys.list('mine-pending'),
    queryFn: () => listLiquidations({ status: LiquidationStatus.PENDING }),
  });

  const rows = waiting.data ?? [];

  if (waiting.isPending || rows.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Liquidations waiting on you</CardTitle>
        <CardDescription>
          Cash you were advanced that still has to be accounted for. Open the trip to add your
          expenses and receipts, then submit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {rows.map((liquidation) => (
            <li key={liquidation.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <Link
                  href={`/shipments/${liquidation.shipmentId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {liquidation.shipmentNumber ?? 'Trip'}
                </Link>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">
                    {formatMoney(liquidation.totalAllowance)} advanced
                  </span>
                  <Badge variant="secondary">{LIQUIDATION_STATUS_LABELS[liquidation.status]}</Badge>
                </div>
              </div>
              {liquidation.wasReturned && liquidation.latestReturnReason ? (
                <p className="text-destructive flex items-start gap-2 text-xs">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>Returned: {liquidation.latestReturnReason}</span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
