'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRole, type Shipment } from '@eztruckr/types';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import {
  addAdditionalCharge,
  addBillableExpense,
  listAdditionalCharges,
  listBillableExpenses,
  removeAdditionalCharge,
  removeBillableExpense,
  shipmentKeys,
} from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

type Kind = 'billable' | 'additional';

interface Line {
  id: string;
  description: string;
  amount: string;
  isCommissionable: boolean;
}

/**
 * Billable expenses and additional charges.
 *
 * Kept as two lists rather than one with a type column, because they are two
 * different things to the P&L: a billable expense is a cost the company
 * fronted and recovers, so it lands on both sides; an additional charge has no
 * underlying cost and is pure revenue. Merging them in the UI would invite
 * merging them in the reporting.
 *
 * The commissionable switch is the only thing on this screen that changes what
 * the crew are paid, which is why it is labelled with its consequence rather
 * than just its name.
 */
export function ChargesCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const canEdit = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ChargeList
        kind="billable"
        shipment={shipment}
        canEdit={canEdit}
        title="Billable expenses"
        description="Costs the company fronted and recovers from the client — permits, crane hire, port charges. Revenue and cost both."
      />
      <ChargeList
        kind="additional"
        shipment={shipment}
        canEdit={canEdit}
        title="Additional charges"
        description="Fees with no underlying cost — extra drops, detention, surcharges. Pure revenue."
      />
    </div>
  );
}

function ChargeList({
  kind,
  shipment,
  canEdit,
  title,
  description,
}: {
  kind: Kind;
  shipment: Shipment;
  canEdit: boolean;
  title: string;
  description: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ description: '', amount: '', isCommissionable: false });

  const queryKey =
    kind === 'billable'
      ? shipmentKeys.billableExpenses(shipment.id)
      : shipmentKeys.additionalCharges(shipment.id);

  const lines = useQuery({
    queryKey,
    queryFn: (): Promise<Line[]> =>
      kind === 'billable' ? listBillableExpenses(shipment.id) : listAdditionalCharges(shipment.id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const reportFailure = (error: unknown) => {
    toast.error('Could not save the line', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });
  };

  const add = useMutation({
    mutationFn: () =>
      kind === 'billable'
        ? addBillableExpense(shipment.id, { ...draft, expenseCategoryId: null })
        : addAdditionalCharge(shipment.id, draft),
    onSuccess: () => {
      setDraft({ description: '', amount: '', isCommissionable: false });
      invalidate();
    },
    onError: reportFailure,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      kind === 'billable'
        ? removeBillableExpense(shipment.id, id)
        : removeAdditionalCharge(shipment.id, id),
    onSuccess: invalidate,
    onError: reportFailure,
  });

  const rows = lines.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No lines yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((line) => (
              <li key={line.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate">{line.description}</p>
                  {line.isCommissionable ? (
                    <Badge variant="secondary" className="mt-1">
                      Commissionable
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatMoney(line.amount)}</span>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${line.description}`}
                      onClick={() => remove.mutate(line.id)}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <Label htmlFor={`${kind}-description`} className="sr-only">
                  Description
                </Label>
                <Input
                  id={`${kind}-description`}
                  placeholder="Description"
                  required
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
              <div className="w-32">
                <Label htmlFor={`${kind}-amount`} className="sr-only">
                  Amount
                </Label>
                <Input
                  id={`${kind}-amount`}
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
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor={`${kind}-commissionable`}
                className="text-muted-foreground text-xs font-normal"
              >
                Commissionable — include in the crew&apos;s commission base
              </Label>
              <Switch
                id={`${kind}-commissionable`}
                checked={draft.isCommissionable}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({ ...current, isCommissionable: checked }))
                }
              />
            </div>
            <Button type="submit" size="sm" disabled={add.isPending}>
              {add.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add line
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
