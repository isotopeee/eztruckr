'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ADJUSTMENT_DIRECTION_LABELS,
  AdjustmentDirection,
  COMMISSION_METHOD_LABELS,
  CREW_ROLE_LABELS,
  CommissionMethod,
  UserRole,
  formatRate,
  type Adjustment,
  type Commission,
  type CrewPayLine,
  type Shipment,
} from '@eztruckr/types';
import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  addAdjustment,
  computeCommissions,
  getCrewPay,
  removeAdjustment,
  shipmentKeys,
} from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * What each crew member earns on this trip: the computed commission, any
 * adjustments to it, and the total.
 *
 * DRIVEN BY `crew-pay`, NOT BY THE COMMISSIONS LIST, because the net is money
 * arithmetic and nothing under `src/` does money arithmetic. The API adds the
 * commission and the adjustments together; this renders three numbers it was
 * given.
 *
 * The commission row still shows base, rate and amount together so the
 * multiplication is visible rather than asserted — and an adjustment is shown
 * BESIDE it rather than folded into it, because the commission is frozen and
 * self-verifying and an adjustment is somebody's decision with a reason. A
 * screen that showed only the total would make the two indistinguishable.
 */
export function CommissionsCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const canCompute = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const crewPay = useQuery({
    queryKey: shipmentKeys.crewPay(shipment.id),
    queryFn: () => getCrewPay(shipment.id),
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

  const lines = crewPay.data ?? [];
  const paid = lines.some((line) => line.commission?.payoutLineId);

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
            recomputing is closed and the charges are locked with them. An adjustment can still be
            recorded — it is a separate line on a future run, not a change to what was paid.
          </p>
        ) : null}

        {crewPay.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No commissions computed for this shipment yet.
          </p>
        ) : (
          <div className="space-y-3">
            {lines.map((line) => (
              <CrewPayRow
                key={line.staffId}
                shipmentId={shipment.id}
                line={line}
                canAdjust={canCompute}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CrewPayRow({
  shipmentId,
  line,
  canAdjust,
}: {
  shipmentId: string;
  line: CrewPayLine;
  canAdjust: boolean;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const remove = useMutation({
    mutationFn: (id: string) => removeAdjustment(id),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error('Could not remove that adjustment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const hasAdjustments = line.adjustments.length > 0;

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{line.staffName}</span>
          {line.commission ? (
            <Badge variant="secondary">{CREW_ROLE_LABELS[line.commission.role]}</Badge>
          ) : null}
          {line.commission?.payoutLineId ? <Badge>Paid</Badge> : null}
        </div>
        {/* The net leads only when it differs from the commission; otherwise
            showing two identical figures invites the reader to hunt for a
            difference that is not there. */}
        <span className="text-base font-medium tabular-nums">{formatMoney(line.netAmount)}</span>
      </div>

      {line.commission ? (
        <CommissionDetail commission={line.commission} />
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          No commission computed for this person on this trip — the adjustment below stands on its
          own.
        </p>
      )}

      {hasAdjustments ? (
        <div className="mt-3 space-y-1 border-t pt-2">
          <div className="text-muted-foreground flex items-baseline justify-between text-xs">
            <span>Commission</span>
            <span className="tabular-nums">{formatMoney(line.commissionAmount)}</span>
          </div>
          {line.adjustments.map((adjustment) => (
            <AdjustmentRow
              key={adjustment.id}
              adjustment={adjustment}
              canRemove={canAdjust}
              onRemove={() => remove.mutate(adjustment.id)}
              removing={remove.isPending}
            />
          ))}
          <div className="flex items-baseline justify-between border-t pt-1 text-sm font-medium">
            <span>Net pay</span>
            <span className="tabular-nums">{formatMoney(line.netAmount)}</span>
          </div>
        </div>
      ) : null}

      {canAdjust ? (
        adding ? (
          <AdjustmentForm
            shipmentId={shipmentId}
            staffId={line.staffId}
            onDone={() => {
              setAdding(false);
              invalidate();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button variant="ghost" size="sm" className="mt-2 -ml-2" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3 w-3" />
            Adjust {line.staffName.split(' ')[0]}&apos;s pay
          </Button>
        )
      ) : null}
    </div>
  );
}

function AdjustmentRow({
  adjustment,
  canRemove,
  onRemove,
  removing,
}: {
  adjustment: Adjustment;
  canRemove: boolean;
  onRemove: () => void;
  removing: boolean;
}) {
  const isDecrease = adjustment.direction === AdjustmentDirection.DECREASE;

  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <div className="min-w-0">
        <span className={isDecrease ? 'text-destructive' : ''}>
          {ADJUSTMENT_DIRECTION_LABELS[adjustment.direction]}
        </span>
        <span className="text-muted-foreground"> · {adjustment.reason}</span>
        {adjustment.approvedByName ? (
          <span className="text-muted-foreground"> · {adjustment.approvedByName}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span className={`tabular-nums ${isDecrease ? 'text-destructive' : ''}`}>
          {/* The sign came from the API. Rendering `signedAmount` rather than
              deciding here is what stops a screen disagreeing with a payout. */}
          {formatMoney(adjustment.signedAmount)}
        </span>
        {canRemove && adjustment.isEditable ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={`Remove adjustment: ${adjustment.reason}`}
            onClick={onRemove}
            disabled={removing}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        ) : null}
        {!adjustment.isEditable ? <Badge variant="outline">Paid</Badge> : null}
      </div>
    </div>
  );
}

/**
 * Recording an adjustment. The reason is required by the form because it is
 * required by the schema and by a CHECK — an unexplained change to somebody's
 * pay cannot be told apart from a mistake when they query it.
 */
function AdjustmentForm({
  shipmentId,
  staffId,
  onDone,
  onCancel,
}: {
  shipmentId: string;
  staffId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({
    direction: String(AdjustmentDirection.INCREASE),
    amount: '',
    reason: '',
  });

  const save = useMutation({
    mutationFn: () =>
      addAdjustment({
        staffId,
        shipmentId,
        direction: Number(draft.direction) as AdjustmentDirection,
        amount: draft.amount,
        reason: draft.reason,
      }),
    onSuccess: () => {
      toast.success('Adjustment recorded');
      onDone();
    },
    onError: (error) =>
      toast.error('Could not record that adjustment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  return (
    <form
      className="mt-3 space-y-2 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`adj-direction-${staffId}`} className="text-xs">
            Direction
          </Label>
          <Select
            value={draft.direction}
            onValueChange={(value) => setDraft((current) => ({ ...current, direction: value }))}
          >
            <SelectTrigger id={`adj-direction-${staffId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={String(AdjustmentDirection.INCREASE)}>
                {ADJUSTMENT_DIRECTION_LABELS[AdjustmentDirection.INCREASE]}
              </SelectItem>
              <SelectItem value={String(AdjustmentDirection.DECREASE)}>
                {ADJUSTMENT_DIRECTION_LABELS[AdjustmentDirection.DECREASE]}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`adj-amount-${staffId}`} className="text-xs">
            Amount
          </Label>
          <Input
            id={`adj-amount-${staffId}`}
            placeholder="0.00"
            inputMode="decimal"
            required
            value={draft.amount}
            onChange={(event) =>
              setDraft((current) => ({ ...current, amount: event.target.value }))
            }
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`adj-reason-${staffId}`} className="text-xs">
          Reason
        </Label>
        <Input
          id={`adj-reason-${staffId}`}
          placeholder="Why this trip's pay is being changed"
          required
          value={draft.reason}
          onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
          Record adjustment
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CommissionDetail({ commission }: { commission: Commission }) {
  const isFormula = commission.appliedMethod === CommissionMethod.FORMULA;

  const base = commission.commissionableBase;

  return (
    <div className="text-muted-foreground mt-2 space-y-1 text-xs">
      <p>
        {COMMISSION_METHOD_LABELS[commission.appliedMethod]}
        {commission.appliedRuleName ? (
          <>
            {' · '}
            {/* The name frozen at computation, not the rule's name today —
                a rename must not relabel an old voucher. */}
            <span title={`Rule ${commission.appliedRuleId ?? ''}`}>
              {commission.appliedRuleName}
            </span>
          </>
        ) : null}
      </p>
      <p className="tabular-nums">
        {formatMoney(base)} base
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
        <div className="bg-muted/50 mt-2 rounded p-2">
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
  );
}
