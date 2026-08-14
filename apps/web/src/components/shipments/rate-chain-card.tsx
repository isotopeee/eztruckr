'use client';

import { SHIPMENT_STATUS_LABELS, UserRole, formatRate, type Shipment } from '@eztruckr/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * The rate chain and the commission chain, shown as arithmetic.
 *
 * Every figure here is read from the shipment exactly as the API stored it —
 * nothing on this screen is derived in the browser. The layout deliberately
 * reads like a worksheet, one operation per line, because the promise the
 * backend makes is that a reviewer can reproduce each line from the one above
 * it with a calculator. A summary card that only showed the totals would hide
 * precisely the thing that makes the figures checkable.
 */

function Row({
  label,
  value,
  operator,
  note,
  emphasis,
}: {
  label: string;
  value: string | null;
  operator?: '−' | '+' | '×' | '=';
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1.5 ${
        emphasis ? 'border-t font-medium' : ''
      }`}
    >
      <div className="min-w-0">
        <span className="text-muted-foreground mr-2 inline-block w-4 text-right tabular-nums">
          {operator ?? ''}
        </span>
        <span className={emphasis ? '' : 'text-muted-foreground'}>{label}</span>
        {note ? <span className="text-muted-foreground ml-2 text-xs">{note}</span> : null}
      </div>
      <span className="shrink-0 tabular-nums">{value === null ? '—' : formatMoney(value)}</span>
    </div>
  );
}

export function RateChainCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const computed = shipment.commissionsComputedAt !== null;

  /**
   * NOTHING here is for a crew session — not the rate chain, and not the
   * commission base either.
   *
   * This card briefly showed crew the base alone. That was narrowed again by
   * explicit decision: a crew member sees what they earned, on the commissions
   * card, and none of the figures it was computed from. The API nulls every one
   * of them (`redactRevenueForCrew`), so rendering anything here would be a
   * column of "—" that still announces the figures exist and are withheld.
   *
   * Returning null rather than being omitted by the page keeps the rule with
   * the card that would otherwise leak it — a caller who adds this component to
   * a new screen cannot forget the check.
   */
  if (user?.role === UserRole.CREW) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rate chain</CardTitle>
        <CardDescription>
          Gross freight less the broker cut gives the net rate. Every figure is computed and stored
          by the server.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <Row label="Gross rate" value={shipment.grossRate} />
        <Row
          label="Third-party commission"
          value={shipment.tpcAmount}
          operator="−"
          note={
            shipment.appliedTpcRate
              ? `${formatRate(shipment.appliedTpcRate)} of gross`
              : shipment.thirdPartyId
                ? 'flat amount agreed'
                : 'direct client'
          }
        />
        <Row label="Net rate" value={shipment.netRate} operator="=" emphasis />

        <div className="mt-6">
          <h4 className="mb-1 font-medium">Commission base</h4>
          {!computed ? (
            <p className="text-muted-foreground py-2 text-xs">
              Not computed yet. The base is derived when commissions are computed, and frozen at
              that moment — {SHIPMENT_STATUS_LABELS[shipment.status].toLowerCase()} shipments show
              it once that has happened.
            </p>
          ) : (
            <>
              <Row label="Net rate" value={shipment.netRate} />
              <Row
                label="Commissionable charges"
                value={shipment.commissionableCharges}
                operator="+"
                note="only lines flagged commissionable"
              />
              <Row label="Gross for commission" value={shipment.grossForCommission} operator="=" />
              <Row
                label="Gas expense deduction"
                value={shipment.gasDeductionAmount}
                operator="−"
                // The rate this computation used, stated plainly and nothing
                // more. It deliberately does NOT say whether that rate came
                // from an override: `gasRateOverrideReason` describes the
                // override in force *now*, which may have been set after this
                // computation ran, so annotating from it would be a claim this
                // card cannot substantiate. The gas card below owns that
                // distinction, and shows the frozen and effective rates side
                // by side when they differ.
                note={
                  shipment.appliedGasDeductionRate
                    ? formatRate(shipment.appliedGasDeductionRate)
                    : undefined
                }
              />
              <Row
                label="Commissionable base"
                value={shipment.commissionableBase}
                operator="="
                emphasis
              />
              <p className="text-muted-foreground mt-3 text-xs">
                The gas deduction reduces the commission base only. It is not a cost line — actual
                fuel is recognised through the liquidation, and counting it here as well would
                double it.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
