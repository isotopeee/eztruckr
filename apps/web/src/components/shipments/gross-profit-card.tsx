'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatRate, grossProfitCaveats, type Shipment } from '@eztruckr/types';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';
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
  const queryClient = useQueryClient();
  const grossProfit = useQuery({
    queryKey: shipmentKeys.grossProfit(shipment.id),
    queryFn: () => getGrossProfit(shipment.id),
  });

  /**
   * Ask the API for the figure again.
   *
   * NOT A CACHE BUST DRESSED UP AS ARITHMETIC: the sum is done server-side on
   * every request, so this button is the only way a reader can be sure the
   * number in front of them counts the charge somebody else added a minute
   * ago. Queries here go stale after 30s and do not refetch on focus, so a
   * card left open can sit on a figure that has since moved.
   *
   * THE LINES REFRESH WITH THE TOTAL, and that is the whole point rather than
   * a courtesy. The charges and company expenses above are separate queries
   * over the same figures this breakdown itemises, so refreshing the total
   * alone would leave it counting a charge the list above it does not yet
   * show — a total that cannot be followed back to its lines, which is the one
   * thing this card exists to prevent. The total is refetched directly for its
   * error result; the siblings are invalidated around it.
   *
   * The failure is announced rather than swallowed. A refetch that errors
   * leaves the previous data on screen, so a silent one would answer "is this
   * current?" with an unchanged number that means the opposite.
   */
  const recompute = async () => {
    const [result] = await Promise.all([
      grossProfit.refetch(),
      queryClient.invalidateQueries({
        queryKey: shipmentKeys.detail(shipment.id),
        predicate: (query) => query.queryKey.at(-1) !== 'gross-profit',
      }),
    ]);

    if (result.isError) {
      toast.error('Could not recompute gross profit', {
        description:
          result.error instanceof ApiError ? result.error.displayMessage : String(result.error),
      });
    }
  };

  const data = grossProfit.data;

  if (!data) {
    return null;
  }

  const caveats = grossProfitCaveats(data);
  const isLoss = data.grossProfit.startsWith('-');

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Gross profit</CardTitle>
          <CardDescription>
            Revenue on this trip, less what it cost to run — derived from the lines below every time
            it is asked for, never stored.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void recompute()}
          disabled={grossProfit.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${grossProfit.isFetching ? 'animate-spin' : ''}`} />
          Recompute
        </Button>
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
            {/* Only the rebills the OFFICE paid for. The crew-paid ones are
                already inside the liquidated figure above, so this line is
                smaller than its revenue twin whenever the crew fronted any —
                and the note is what stops that gap reading as a rounding
                error or a duplicate. */}
            <Line
              label="Billable expenses"
              amount={data.companyPaidBillableExpenses}
              note="company-paid only — the crew’s are in their liquidation"
            />
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
