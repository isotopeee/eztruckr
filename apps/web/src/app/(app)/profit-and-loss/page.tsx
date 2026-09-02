'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ProfitAndLoss, UserRole } from '@eztruckr/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatMoney, toDateInputValue } from '@/lib/format';
import { PAGE_ROLES } from '@/lib/nav';
import { fetchProfitAndLoss, profitAndLossKeys, windowFromDates } from '@/lib/profit-and-loss-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * Widened from the `PAGE_ROLES` tuple, which infers as its literal members and
 * so refuses `includes` against any other role.
 */
const MAY_OPEN: readonly UserRole[] = PAGE_ROLES.profitAndLoss;

/**
 * What the business made over a period.
 *
 * READ AS A DATE RANGE, unlike `/operation-expenses` beside it, and the
 * difference is deliberate rather than inconsistent. That screen is a ledger
 * somebody scrolls a month at a time, so a month picker is both the natural
 * control and the thing that keeps the API's exclusive upper bound away from
 * whoever is typing. A P&L is asked for over periods that are not months — a
 * quarter, a year to date, the six weeks before a rate review — so the dates
 * are offered, the upper one is INCLUSIVE on screen, and `windowFromDates`
 * does the translation in one place. Nobody has to know the edge exists.
 *
 * THREE LINES, IN THE ORDER THEY ARE ASKED ABOUT. Revenue less what the trips
 * cost is gross profit; gross profit less what the office cost is what the
 * company kept. A single "profit" figure hides which of the two moved, and
 * those are different conversations.
 *
 * THE TRIPS ARE LISTED UNDERNEATH, and their column adds up to the heading
 * exactly — the API computes both from the same per-trip figures. The first
 * question of a bad month is "which trips", and it should not need a second
 * screen.
 *
 * NOTHING IS COMPUTED HERE. Every figure, both margins included, arrives as a
 * decimal string the API worked out. The page formats.
 */
export default function Page() {
  const { user, isPending: userPending } = useCurrentUser();

  const mayOpen = !!user && MAY_OPEN.includes(user.role);

  // Defaults to the current month in Manila, which is the period somebody
  // opening this screen is nearly always asking about. Both ends are dates the
  // user could have typed themselves — nothing here is a hidden bound.
  const [from, setFrom] = useState(() => startOfThisMonth());
  const [to, setTo] = useState(() => today());

  const filters = windowFromDates(from, to);

  const report = useQuery({
    queryKey: profitAndLossKeys.report(filters),
    queryFn: () => fetchProfitAndLoss(filters),
    enabled: mayOpen,
  });

  if (userPending) {
    return <p className="text-muted-foreground p-6 text-sm">Loading…</p>;
  }

  if (!mayOpen) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Profit and loss</h1>
        <p className="text-muted-foreground mt-2 text-sm">You do not have access to this report.</p>
      </div>
    );
  }

  const data = report.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Profit and loss</h1>
        <p className="text-muted-foreground text-sm">
          What the business made over a period. Trips are counted by the date they ran, and the
          company&rsquo;s own running costs are subtracted once at the bottom — never charged to a
          trip.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full space-y-1 sm:w-44">
            <Label htmlFor="pl-from">From</Label>
            <Input
              id="pl-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="w-full space-y-1 sm:w-44">
            <Label htmlFor="pl-to">To</Label>
            <Input
              id="pl-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            {/* Said out loud, because the API's bound is the other way and this
                is the one place a reader could be wrong about a whole day. */}
            <p className="text-muted-foreground text-xs">This day is included.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:pb-1">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const range = preset.range();
                  setFrom(range.from);
                  setTo(range.to);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </CardHeader>

        <CardContent>
          {report.isPending ? (
            <p className="text-muted-foreground py-6 text-sm">Loading…</p>
          ) : report.isError ? (
            <p className="text-destructive py-6 text-sm">
              {report.error instanceof ApiError
                ? report.error.displayMessage
                : 'Could not load the report.'}
            </p>
          ) : data ? (
            <Statement report={data} />
          ) : null}
        </CardContent>
      </Card>

      {data && data.byShipment.length > 0 ? <Trips report={data} /> : null}
    </div>
  );
}

/**
 * The statement itself: revenue, what the trips cost, and what the office cost.
 *
 * INDENTED COMPONENTS UNDER BOLD SUBTOTALS, which is how a P&L is read on
 * paper. The three lines that matter — revenue, gross profit, net profit — are
 * the ones a reader should be able to find without reading anything else.
 */
function Statement({ report }: { report: ProfitAndLoss }) {
  const netIsLoss = Number(report.netProfit) < 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Headline label="Revenue" amount={report.revenue} />
        <Headline label="Gross profit" amount={report.grossProfit} margin={report.grossMargin} />
        <Headline
          label={netIsLoss ? 'Net loss' : 'Net profit'}
          amount={report.netProfit}
          margin={report.netMargin}
          tone={netIsLoss ? 'loss' : 'profit'}
        />
      </div>

      {report.isProvisional ? (
        <p className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs">
          Provisional —{' '}
          {report.provisionalShipmentCount === 1
            ? '1 trip in this period is'
            : `${report.provisionalShipmentCount} trips in this period are`}{' '}
          still unfinished, so these figures will move. A trip is final once its liquidation is
          approved and its commissions are computed and up to date.
        </p>
      ) : null}

      <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
        <section className="space-y-1">
          <SectionHeading>Revenue</SectionHeading>
          <Line label="Gross freight rate" amount={report.grossRate} indent />
          <Line
            label="Less third-party commission"
            amount={report.thirdPartyCommission}
            indent
            negated
          />
          <Line label="Net freight rate" amount={report.netRate} />
          <Line label="Rebilled expenses" amount={report.billableExpenses} indent />
          <Line label="Additional charges" amount={report.additionalCharges} indent />
          <Line label="Total revenue" amount={report.revenue} emphasis />
        </section>

        <section className="space-y-1">
          <SectionHeading>Trip costs</SectionHeading>
          <Line label="Crew liquidations" amount={report.liquidatedExpenses} indent />
          <Line label="Company-paid expenses" amount={report.companyPaidExpenses} indent />
          <Line label="Company-paid rebills" amount={report.companyPaidBillableExpenses} indent />
          <Line label="Crew commissions" amount={report.crewCommissions} indent />
          <Line label="Total trip costs" amount={report.directCost} emphasis />
          <div className="pt-2">
            <Line label="Gross profit" amount={report.grossProfit} emphasis />
          </div>
        </section>

        <section className="space-y-1 md:col-span-2">
          <SectionHeading>
            Operating expenses{' '}
            <span className="text-muted-foreground font-normal">
              — the company&rsquo;s own costs, belonging to no trip
            </span>
          </SectionHeading>
          {report.operatingExpensesByCategory.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">Nothing recorded for this period.</p>
          ) : (
            report.operatingExpensesByCategory.map((category) => (
              <Line
                key={category.expenseCategoryId}
                label={`${category.expenseCategoryName ?? 'Uncategorised'} (${category.count})`}
                amount={category.amount}
                indent
              />
            ))
          )}
          <Line label="Total operating expenses" amount={report.operatingExpenses} emphasis />
          <div className="border-t pt-2">
            <Line
              label={netIsLoss ? 'Net loss' : 'Net profit'}
              amount={report.netProfit}
              emphasis
              tone={netIsLoss ? 'loss' : undefined}
            />
          </div>
        </section>
      </div>

      <p className="text-muted-foreground text-xs">
        {report.shipmentCount === 1 ? '1 trip' : `${report.shipmentCount} trips`} ran in this
        period, counted by the date on the paperwork.{' '}
        {report.operationExpenseCount === 1
          ? '1 operating expense was'
          : `${report.operationExpenseCount} operating expenses were`}{' '}
        recorded against it.
      </p>
    </div>
  );
}

/** The trips behind the figures, largest contribution first. */
function Trips({ report }: { report: ProfitAndLoss }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Trips in this period</h2>
        <p className="text-muted-foreground text-sm">
          Each trip&rsquo;s own figures, as its shipment page shows them. The gross profit column
          adds up to the total above.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ran on</TableHead>
              <TableHead>Shipment</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Gross profit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.byShipment.map((trip) => (
              <TableRow key={trip.shipmentId}>
                <TableCell className="whitespace-nowrap">{formatDate(trip.shipmentDate)}</TableCell>
                <TableCell className="font-medium">
                  <Link className="hover:underline" href={`/shipments/${trip.shipmentId}`}>
                    {trip.shipmentNumber}
                  </Link>
                  {trip.isProvisional ? (
                    <Badge variant="outline" className="ml-2">
                      Provisional
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{trip.clientName ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(trip.revenue)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(trip.cost)}</TableCell>
                <TableCell
                  className={`text-right font-medium tabular-nums ${
                    Number(trip.grossProfit) < 0 ? 'text-destructive' : ''
                  }`}
                >
                  {formatMoney(trip.grossProfit)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Headline({
  label,
  amount,
  margin,
  tone,
}: {
  label: string;
  amount: string;
  margin?: string | null;
  tone?: 'profit' | 'loss';
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground text-sm">{label}</p>
      <p
        className={`text-2xl font-semibold tabular-nums ${
          tone === 'loss' ? 'text-destructive' : ''
        }`}
      >
        {formatMoney(amount)}
      </p>
      {/* Null rather than zero when there was no revenue — the API says so, and
          "0.0%" would read like a real margin that happened to break even. */}
      {margin === undefined ? null : (
        <p className="text-muted-foreground text-xs">
          {margin === null ? 'No margin — nothing was billed' : `${formatPercent(margin)} margin`}
        </p>
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="border-b pb-1 text-sm font-semibold">{children}</h3>;
}

function Line({
  label,
  amount,
  indent,
  emphasis,
  negated,
  tone,
}: {
  label: string;
  amount: string;
  indent?: boolean;
  emphasis?: boolean;
  /** Shown as a deduction, because the line reads as one on the statement. */
  negated?: boolean;
  tone?: 'loss';
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 text-sm ${
        emphasis ? 'font-semibold' : ''
      } ${indent ? 'pl-4' : ''}`}
    >
      <span className={indent ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${tone === 'loss' ? 'text-destructive' : ''}`}>
        {negated && Number(amount) !== 0 ? `(${formatMoney(amount)})` : formatMoney(amount)}
      </span>
    </div>
  );
}

/**
 * A rate as a percentage, for display only.
 *
 * The API sends "0.1834"; this renders "18.34%". The one arithmetic operation
 * on this page, and it is on a rate rather than on money — no peso figure is
 * ever computed in the browser.
 */
function formatPercent(rate: string): string {
  return `${(Number(rate) * 100).toFixed(1)}%`;
}

/** Today in Manila, as `YYYY-MM-DD`. */
function today(): string {
  return toDateInputValue(new Date().toISOString());
}

function startOfThisMonth(): string {
  return `${today().slice(0, 7)}-01`;
}

/**
 * The periods actually asked for, as one click each.
 *
 * They set the two date fields rather than a hidden mode, so a preset is a
 * starting point somebody can then adjust — and what is being reported is
 * always visible in the fields rather than implied by a highlighted button.
 */
const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  {
    label: 'This month',
    range: () => ({ from: startOfThisMonth(), to: today() }),
  },
  {
    label: 'Last month',
    range: () => {
      const start = new Date(`${startOfThisMonth()}T00:00:00.000Z`);
      const end = new Date(start);
      end.setUTCDate(0); // The last day of the previous month.
      start.setUTCMonth(start.getUTCMonth() - 1);

      return { from: asDate(start), to: asDate(end) };
    },
  },
  {
    label: 'This quarter',
    range: () => {
      const now = new Date(`${today()}T00:00:00.000Z`);
      const start = new Date(now);
      start.setUTCMonth(Math.floor(now.getUTCMonth() / 3) * 3, 1);

      return { from: asDate(start), to: today() };
    },
  },
  {
    label: 'Year to date',
    range: () => ({ from: `${today().slice(0, 4)}-01-01`, to: today() }),
  },
];

/** A UTC date as the `YYYY-MM-DD` an `<input type="date">` wants. */
function asDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
