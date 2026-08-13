'use client';

import { useQuery } from '@tanstack/react-query';
import { formatRate, grossProfitCaveats, type Shipment } from '@eztruckr/types';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { getGrossProfit, shipmentKeys } from '@/lib/shipment-api';

/**
 * What the trip made, and out of what.
 *
 * THE BREAKDOWN IS NOT DECORATION. A single margin figure is a number nobody
 * can check; the point of listing every component is that a reader can follow
 * it back to the lines on this page. The three things deliberately excluded —
 * allowances, the gas deduction, the settlement variance — are named at the
 * bottom for the same reason: their absence is a decision, and a reader who
 * cannot see it will assume an omission.
 *
 * The crew's expenses count AS THEY ARE CLAIMED, which is why the cost line is
 * labelled differently before and after approval. A trip still in transit is
 * exactly when somebody wants to know whether it is earning, and money the crew
 * have already spent does not become less spent by waiting for a signature —
 * but a running figure read as a settled one is its own mistake, so the label,
 * the note and the banner all say which it is.
 */
export function GrossProfitCard({ shipment }: { shipment: Shipment }) {
  const grossProfit = useQuery({
    queryKey: shipmentKeys.grossProfit(shipment.id),
    queryFn: () => getGrossProfit(shipment.id),
  });

  const data = grossProfit.data;

  if (!data) {
    return null;
  }

  const caveats = grossProfitCaveats(data);
  const isLoss = data.grossProfit.startsWith('-');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gross profit</CardTitle>
        <CardDescription>
          Revenue on this trip, less what it cost to run — derived from the lines below every time
          it is asked for, never stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {caveats.length > 0 ? (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="font-medium">Provisional — this figure will still move.</p>
              <ul className="text-muted-foreground list-disc space-y-0.5 pl-4">
                {caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <div className="grid gap-6 sm:grid-cols-2">
          <section className="space-y-1">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Revenue
            </h3>
            <Line label="Gross rate" amount={data.grossRate} />
            <Line label="Third-party cut" amount={data.thirdPartyCommission} negated />
            <Line label="Net rate" amount={data.netRate} muted />
            <Line label="Billable expenses" amount={data.billableExpenses} />
            <Line label="Additional charges" amount={data.additionalCharges} />
            <Line label="Total revenue" amount={data.revenue} strong />
          </section>

          <section className="space-y-1">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Cost
            </h3>
            {/* The label changes with the status, not just a note beside it:
                "liquidated" and "claimed so far" are different claims about
                the same figure, and only one of them is true at a time. */}
            <Line
              label={data.costsRecognised ? 'Liquidated by crew' : 'Claimed by crew so far'}
              amount={data.liquidatedExpenses}
              note={data.costsRecognised ? undefined : 'running, not yet approved'}
            />
            <Line label="Company-paid" amount={data.companyPaidExpenses} />
            <Line
              label="Crew commissions"
              amount={data.crewCommissions}
              note={data.commissionsComputed ? undefined : 'not computed'}
            />
            <Line label="Total cost" amount={data.cost} strong />
          </section>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-4">
          <span className="text-sm font-medium">Gross profit</span>
          <span className="flex items-baseline gap-3">
            <span
              className={`text-2xl font-semibold tabular-nums ${isLoss ? 'text-destructive' : ''}`}
            >
              {formatMoney(data.grossProfit)}
            </span>
            <span className="text-muted-foreground text-sm tabular-nums">
              {data.margin === null ? 'no revenue' : `${formatRate(data.margin)} margin`}
            </span>
          </span>
        </div>

        <p className="text-muted-foreground text-xs">
          Excluded on purpose: allowances (cash advanced is owed back, not spent), the gas deduction
          (it lowers the commission base only — the fuel itself is already counted above), and the
          settlement variance (cash squaring an advance, not a cost).
        </p>
      </CardContent>
    </Card>
  );
}

function Line({
  label,
  amount,
  negated = false,
  strong = false,
  muted = false,
  note,
}: {
  label: string;
  amount: string;
  negated?: boolean;
  strong?: boolean;
  muted?: boolean;
  note?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 text-sm ${
        strong ? 'border-t pt-1 font-medium' : ''
      } ${muted ? 'text-muted-foreground' : ''}`}
    >
      <span>
        {label}
        {note ? <span className="text-muted-foreground text-xs"> · {note}</span> : null}
      </span>
      <span className="tabular-nums">
        {negated && amount !== '0.00' ? '−' : ''}
        {formatMoney(amount)}
      </span>
    </div>
  );
}
