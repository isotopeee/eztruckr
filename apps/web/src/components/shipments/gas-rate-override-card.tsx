'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRole, formatRate, type Shipment } from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { getGasRate, setGasRate, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * The per-shipment gas deduction rate, shown against the system default.
 *
 * Showing both is the requirement and also the point: an override is only
 * meaningful relative to what it departs from, and someone reviewing a payout
 * months later needs to see that this trip used 30% while the company used
 * 25%, and why. The reason is mandatory server-side, so the form makes it
 * mandatory too rather than letting the request fail.
 */
export function GasRateOverrideCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const canEdit = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const context = useQuery({
    queryKey: shipmentKeys.gasRate(shipment.id),
    queryFn: () => getGasRate(shipment.id),
  });

  useEffect(() => {
    if (!context.data) return;
    setRate(context.data.override ?? '');
    setReason(context.data.reason ?? '');
  }, [context.data]);

  const save = useMutation({
    mutationFn: (input: { rate: string | null; reason: string | null }) =>
      setGasRate(shipment.id, input),
    onSuccess: () => {
      setFieldError(null);
      toast.success('Gas deduction rate updated');
      void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const field = error.fieldErrors.reason ?? error.fieldErrors.rate;
        setFieldError(field ?? error.displayMessage);
        return;
      }
      setFieldError(String(error));
    },
  });

  const data = context.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gas expense deduction</CardTitle>
        <CardDescription>
          Reduces the commission base only — never a cost line, because actual fuel is already
          recognised through the liquidation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!data ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2">
              <dt className="text-muted-foreground">System default</dt>
              <dd className="tabular-nums">{formatRate(data.systemDefault)}</dd>

              <dt className="text-muted-foreground">This shipment will use</dt>
              <dd className="tabular-nums">
                {formatRate(data.effective)}
                {data.isOverride ? (
                  <span className="text-muted-foreground ml-2 text-xs">overridden</span>
                ) : null}
              </dd>

              {/* Shown separately because it can differ from the line above:
                  changing the override after computing leaves the frozen rate
                  behind until somebody recomputes. Collapsing the two would
                  make the card quietly wrong about one of them. */}
              {data.frozen !== null ? (
                <>
                  <dt className="text-muted-foreground">Last computed with</dt>
                  <dd className="tabular-nums">
                    {formatRate(data.frozen)}
                    {data.frozen !== data.effective ? (
                      <span className="ml-2 text-xs text-amber-600">
                        recompute to apply {formatRate(data.effective)}
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>

            {data.isOverride && data.reason ? (
              <p className="bg-muted/50 rounded p-2 text-xs">
                <span className="text-muted-foreground">Reason: </span>
                {data.reason}
              </p>
            ) : null}

            {canEdit ? (
              <form
                className="space-y-3 border-t pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate(
                    rate.trim() === ''
                      ? { rate: null, reason: null }
                      : { rate: rate.trim(), reason: reason.trim() || null },
                  );
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="gas-override">Override rate</Label>
                  <Input
                    id="gas-override"
                    inputMode="decimal"
                    placeholder={`empty uses the system default (${data.systemDefault})`}
                    value={rate}
                    onChange={(event) => setRate(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    A multiplier between 0 and 1 — 0.25 is 25%. Clear it to fall back to the system
                    default.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="gas-reason">Reason</Label>
                  <Textarea
                    id="gas-reason"
                    rows={2}
                    required={rate.trim() !== ''}
                    placeholder="Required whenever a rate is set"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                {fieldError ? <p className="text-destructive text-xs">{fieldError}</p> : null}
                <Button type="submit" size="sm" disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save rate
                </Button>
              </form>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
