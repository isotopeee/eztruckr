'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMMISSION_METHOD_LABELS,
  CREW_ROLE_LABELS,
  CommissionMethod,
  UserRole,
  formatRate,
  type Commission,
  type Shipment,
} from '@eztruckr/types';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { computeCommissions, listCommissions, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * Computed commissions, with every input that produced them.
 *
 * The row shows base, rate and amount together so the multiplication is
 * visible rather than asserted. For a formula rule it also shows the
 * expression and the field values it read, because that is the one method
 * whose logic lives in editable data — without them the amount stops being
 * reproducible the moment somebody edits the rule.
 */
export function CommissionsCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const canCompute = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const commissions = useQuery({
    queryKey: shipmentKeys.commissions(shipment.id),
    queryFn: () => listCommissions(shipment.id),
  });

  const compute = useMutation({
    mutationFn: () => computeCommissions(shipment.id),
    onSuccess: (result) => {
      toast.success(result.recomputed ? 'Commissions recomputed' : 'Commissions computed', {
        description: `Base ${formatMoney(result.chain.commissionableBase)} across ${
          result.commissions.length
        } crew member(s).`,
      });
      void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
    },
    onError: (error) => {
      // The engine refuses rather than inventing a rate, so its message is the
      // actionable part — show it verbatim instead of a generic failure.
      toast.error('Commissions were not computed', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      });
    },
  });

  const rows = commissions.data ?? [];
  const paid = rows.some((row) => row.payoutLineId !== null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Crew commissions</CardTitle>
          <CardDescription>
            {shipment.commissionsComputedAt
              ? `Computed ${formatDateTime(shipment.commissionsComputedAt)}. Rates are frozen — later changes to a rule cannot move these figures.`
              : 'Not computed yet.'}
          </CardDescription>
        </div>
        {canCompute ? (
          <Button
            onClick={() => compute.mutate()}
            disabled={compute.isPending || paid}
            variant={shipment.commissionsStale ? 'default' : 'outline'}
          >
            {compute.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {shipment.commissionsComputedAt ? 'Recompute' : 'Compute commissions'}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {shipment.commissionsStale ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              A charge on this shipment changed after these commissions were computed, so the base
              below no longer follows from the line items beside it. Recompute to bring them back
              into agreement.
            </p>
          </div>
        ) : null}

        {paid ? (
          <p className="text-muted-foreground text-xs">
            Some of these commissions have been paid. The figures behind a payout cannot move, so
            recomputing is closed and the charges are locked with them.
          </p>
        ) : null}

        {commissions.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No commissions computed for this shipment yet.
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <CommissionRow key={row.id} commission={row} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CommissionRow({ commission }: { commission: Commission }) {
  const isFormula = commission.appliedMethod === CommissionMethod.FORMULA;

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{commission.crewMemberName}</span>
          <Badge variant="secondary">{CREW_ROLE_LABELS[commission.role]}</Badge>
          {commission.payoutLineId ? <Badge>Paid</Badge> : null}
        </div>
        <span className="text-base font-medium tabular-nums">{formatMoney(commission.amount)}</span>
      </div>

      <div className="text-muted-foreground mt-2 space-y-1 text-xs">
        <p>{COMMISSION_METHOD_LABELS[commission.appliedMethod]}</p>
        <p className="tabular-nums">
          {formatMoney(commission.commissionableBase)} base
          {commission.appliedRate === null ? (
            <span className="ml-2">
              — no meaningful rate for this method on this shipment (the amount is authoritative)
            </span>
          ) : (
            <>
              {' × '}
              {formatRate(commission.appliedRate)}
              {isFormula ? ' effective' : ''}
              {' = '}
              {formatMoney(commission.amount)}
            </>
          )}
        </p>

        {isFormula && commission.appliedFormulaExpression ? (
          <div className="mt-2 rounded bg-muted/50 p-2">
            <code className="block break-all">{commission.appliedFormulaExpression}</code>
            {commission.appliedFormulaFields ? (
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
                {Object.entries(commission.appliedFormulaFields).map(([field, value]) => (
                  <div key={field} className="contents">
                    <dt className="font-mono">{field}</dt>
                    <dd className="tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
