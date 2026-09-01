'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  AllowanceRequestStatus,
  liquidationAccountLabel,
  PaymentVerificationStatus,
  SETTLEMENT_STATUS_LABELS,
  USER_ROLE_LABELS,
  UserRole,
  type Page as ApiPage,
} from '@eztruckr/types';
import { AlertTriangle, BadgeCheck, HandCoins, Undo2 } from 'lucide-react';
import { HealthStatusCard } from '@/components/health-status-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import {
  getOutstandingAllowances,
  liquidationKeys,
  listAllowanceRequestQueue,
  listLiquidations,
} from '@/lib/liquidation-api';
import { listClientPaymentQueue, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/** The counts an office user can actually see, keyed to a screen they can open. */
const TILES = [
  { key: 'trucks', label: 'Trucks', href: '/trucks' },
  { key: 'staff', label: 'Staff', href: '/staff' },
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
          {/* First, because it is the only card here that somebody is waiting
              on: a truck does not leave until the cash does. */}
          <PendingAllowanceRequestsCard role={user?.role} />
          <PaymentsToVerifyCard role={user?.role} />
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
 * Cash dispatch has asked for and accounting has not answered.
 *
 * ONE LIST READ FROM TWO SIDES, which is why it is one card and not two.
 * Accounting sees a queue of decisions to make; a dispatch manager sees what
 * they are waiting on. Splitting it would mean two endpoints returning the same
 * rows and two definitions of "pending" free to drift apart.
 *
 * MANAGEMENT AND THE DISPATCHER ARE NOT SHOWN IT, though the API would serve
 * them: neither can act on a request, and a work queue nobody can work is a
 * notification, not a dashboard. Both still see every one of these on the trip
 * itself.
 *
 * DISAPPEARS WHEN EMPTY, like the two cards below it. An always-present card
 * reading "nothing pending" trains people to stop looking at that part of the
 * screen.
 */
function PendingAllowanceRequestsCard({ role }: { role: UserRole | undefined }) {
  const decides = role === UserRole.ADMINISTRATOR || role === UserRole.ACCOUNTING;
  const asks = role === UserRole.ADMINISTRATOR || role === UserRole.DISPATCH_MANAGER;

  const requests = useQuery({
    queryKey: liquidationKeys.allowanceRequestQueue(AllowanceRequestStatus.PENDING),
    queryFn: () => listAllowanceRequestQueue({ status: AllowanceRequestStatus.PENDING }),
    enabled: decides || asks,
  });

  const rows = requests.data ?? [];

  if (rows.length === 0) {
    return null;
  }

  return (
    <Card className={decides ? 'border-amber-500/40' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HandCoins
            className={decides ? 'h-4 w-4 text-amber-600' : 'text-muted-foreground h-4 w-4'}
          />
          {decides ? 'Allowance requests to decide' : 'Allowance requests awaiting accounting'}
        </CardTitle>
        <CardDescription>
          {rows.length} request{rows.length === 1 ? '' : 's'} raised by dispatch and not yet
          {decides ? ' answered — approving one releases the cash.' : ' answered.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {rows.map((request) => (
            <li key={request.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                {/* The decision itself is taken on the trip, where the account,
                    the crew and every other release are visible. A queue that
                    let you approve cash without looking at the trip is a queue
                    that gets clicked through. */}
                <Link
                  href={`/shipments/${request.shipmentId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {request.shipmentNumber ?? 'Trip'}
                </Link>
                <p className="text-muted-foreground truncate text-xs">
                  For {request.staffName ?? 'crew'}
                  {request.requestedByName ? ` · asked by ${request.requestedByName}` : ''}
                </p>
                {/* Never conditional — a request always states its purpose,
                    which is most of why this queue is worth reading at all. */}
                <p className="text-muted-foreground truncate text-xs">{request.purpose}</p>
              </div>
              <span className="shrink-0 tabular-nums">{formatMoney(request.amount)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Client payments dispatch has recorded and accounting has not checked.
 *
 * THE SAME LIST READ FROM TWO SIDES, and one card for the same reason as the
 * allowance requests above: accounting sees work to do, the dispatch manager
 * sees what they are waiting on. Two endpoints returning the same rows would be
 * two definitions of "unverified" free to drift.
 *
 * WITHOUT THIS THE CONTROL IS UNWORKABLE, not merely inconvenient. Accounting
 * has no way to know WHICH trips picked up a payment this morning, so a
 * per-trip card alone would mean checking by memory or not at all.
 *
 * NOBODY ELSE IS SHOWN IT, though the API would serve any office reader:
 * neither dispatch nor management can act on one, and a work queue nobody can
 * work is a notification. Both still see every payment on the trip itself.
 *
 * DISAPPEARS WHEN EMPTY, like its neighbours — an always-present card reading
 * "nothing pending" trains people to stop looking at that part of the screen.
 */
function PaymentsToVerifyCard({ role }: { role: UserRole | undefined }) {
  const verifies = role === UserRole.ADMINISTRATOR || role === UserRole.ACCOUNTING;
  const records = verifies || role === UserRole.DISPATCH_MANAGER;

  const payments = useQuery({
    queryKey: shipmentKeys.paymentQueue(PaymentVerificationStatus.UNVERIFIED),
    queryFn: () =>
      listClientPaymentQueue({ verificationStatus: PaymentVerificationStatus.UNVERIFIED }),
    enabled: records,
  });

  const rows = payments.data ?? [];

  if (rows.length === 0) {
    return null;
  }

  return (
    <Card className={verifies ? 'border-amber-500/40' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck
            className={verifies ? 'h-4 w-4 text-amber-600' : 'text-muted-foreground h-4 w-4'}
          />
          {verifies ? 'Payments to verify' : 'Payments awaiting accounting'}
        </CardTitle>
        <CardDescription>
          {rows.length} payment{rows.length === 1 ? '' : 's'} recorded and not yet matched against
          the bank
          {verifies ? ' — they already count toward what each trip has collected.' : '.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {rows.map((payment) => (
            <li key={payment.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                {/* Verified on the trip, where the invoice, the balance and the
                    other payments are visible. A queue that let you tick money
                    off without looking at what it was for is a queue that gets
                    clicked through. */}
                <Link
                  href={`/shipments/${payment.shipmentId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {payment.shipmentNumber ?? 'Trip'}
                </Link>
                <p className="text-muted-foreground truncate text-xs">
                  {payment.clientName ?? 'Client'}
                  {payment.recordedByName ? ` · recorded by ${payment.recordedByName}` : ''}
                </p>
                {payment.referenceNumber ? (
                  <p className="text-muted-foreground truncate text-xs">
                    Ref {payment.referenceNumber}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 tabular-nums">{formatMoney(payment.amount)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Cash that has not come back, and who is holding it.
 *
 * READS THE SETTLEMENT STATUS DIRECTLY. Inferring it from the liquidation would
 * answer a different question — whether the spending was accounted for — and
 * would report a trip as clear while the crew still held the change. A carried
 * balance stays on this list until the payout run recovering it is paid.
 *
 * IT NAMES AN ACCOUNT, which is the point of the whole change behind it. A trip
 * can appear once per account — and several accounts may be one person's — so
 * the row is keyed on the account rather than on the shipment, and labelled with
 * the number as well as the name. While the settlement was one blended figure
 * per trip, this alert was structurally unable to say whose ₱1,400 it was.
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
            <li key={item.liquidationId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <Link
                  href={`/shipments/${item.shipmentId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {item.shipmentNumber}
                </Link>
                <p className="text-muted-foreground truncate text-xs">
                  {liquidationAccountLabel(item.custodianName, item.liquidationSequence)}
                </p>
              </div>
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
              <div className="flex flex-wrap items-baseline gap-2">
                <Link
                  href={`/shipments/${liquidation.shipmentId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {liquidation.shipmentNumber ?? 'Trip'}
                </Link>
                {/* A trip can appear once per ACCOUNT, and one person can hold
                    several, so the name alone no longer tells two rows apart. */}
                <span className="text-muted-foreground text-xs">
                  {liquidationAccountLabel(liquidation.custodianName, liquidation.sequence)}
                </span>
              </div>
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
