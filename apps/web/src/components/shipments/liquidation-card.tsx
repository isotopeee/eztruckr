'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIQUIDATION_HISTORY_ACTION_LABELS,
  LIQUIDATION_STATUS_LABELS,
  LiquidationHistoryAction,
  LiquidationStatus,
  UserRole,
  type ExpenseCategory,
  type Liquidation,
  type Page,
  type Shipment,
} from '@eztruckr/types';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import {
  addLiquidationLine,
  approveLiquidation,
  getLiquidation,
  liquidationKeys,
  receiptContentUrl,
  removeLiquidationLine,
  returnLiquidation,
  reverseLiquidation,
  submitLiquidation,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { ReceiptField } from './receipt-field';

/**
 * The liquidation: what the trip's cash was actually spent on.
 *
 * WHAT THE STATUSES MEAN ON SCREEN. Pending is with the crew; submitted is with
 * accounting; approved is locked and its costs are recognised. There is no
 * "returned" chip, because a returned liquidation IS pending — what makes it
 * different is the reason banner and the history below, which say who sent it
 * back and why.
 *
 * `recognisedCost` is rendered rather than inferred from the status here, so
 * the screen states the P&L consequence in pesos instead of leaving the reader
 * to work out that a submitted liquidation contributes nothing.
 */
export function LiquidationCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const liquidation = useQuery({
    queryKey: liquidationKeys.liquidation(shipment.id),
    queryFn: () => getLiquidation(shipment.id),
    // A trip that has not been delivered has no liquidation, which is an
    // ordinary state rather than a failure worth retrying.
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: liquidationKeys.all });
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  if (liquidation.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Liquidation</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  if (liquidation.isError || !liquidation.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Liquidation</CardTitle>
          <CardDescription>
            {liquidation.error instanceof ApiError && liquidation.error.status === 404
              ? 'A liquidation is created when this trip is marked delivered.'
              : 'Could not load the liquidation.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const data = liquidation.data;
  const isCrew = user?.role === UserRole.CREW;
  const canDecide = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;
  const canEditLines =
    data.isEditable && (isCrew || canDecide || user?.role === UserRole.OPERATIONS);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle className="text-base">Liquidation</CardTitle>
          <Badge variant={data.status === LiquidationStatus.APPROVED ? 'default' : 'secondary'}>
            {LIQUIDATION_STATUS_LABELS[data.status]}
          </Badge>
          {data.wasReturned ? <Badge variant="outline">Returned for correction</Badge> : null}
        </div>
        <CardDescription>
          Expenses claimed against the cash advanced for this trip. Costs reach the P&amp;L on
          approval and not before.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {data.latestReturnReason && data.status === LiquidationStatus.PENDING ? (
          <div className="border-destructive/40 bg-destructive/5 flex gap-3 rounded-md border p-3">
            <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">Sent back for correction</p>
              <p className="text-muted-foreground">{data.latestReturnReason}</p>
            </div>
          </div>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Figure label="Advanced" value={formatMoney(data.totalAllowance)} />
          <Figure label="Liquidated" value={formatMoney(data.totalLiquidated)} />
          <Figure
            label="Variance"
            value={formatMoney(data.variance)}
            hint={
              data.variance.startsWith('-') ? 'company reimburses crew' : 'crew return this cash'
            }
          />
          <Figure
            label="Recognised cost"
            value={formatMoney(data.recognisedCost)}
            hint={data.status === LiquidationStatus.APPROVED ? 'posted' : 'nothing posts yet'}
          />
        </dl>

        <Lines
          shipment={shipment}
          liquidation={data}
          canEdit={Boolean(canEditLines)}
          onChanged={invalidate}
        />

        <Actions
          shipment={shipment}
          liquidation={data}
          canDecide={canDecide}
          onChanged={invalidate}
        />

        {data.history.length > 0 ? <History liquidation={data} /> : null}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
      {hint ? <dd className="text-muted-foreground text-[11px]">{hint}</dd> : null}
    </div>
  );
}

function Lines({
  shipment,
  liquidation,
  canEdit,
  onChanged,
}: {
  shipment: Shipment;
  liquidation: Liquidation;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState({
    expenseCategoryId: '',
    description: '',
    amount: '',
    spentAt: new Date().toISOString().slice(0, 10),
    receiptId: null as string | null,
    receiptFileName: null as string | null,
  });

  const categories = useQuery({
    queryKey: ['expense-categories', 'selectable'],
    queryFn: () => apiFetch<Page<ExpenseCategory>>('/expense-categories?pageSize=200'),
    enabled: canEdit,
  });

  const reportFailure = (error: unknown) =>
    toast.error('Could not save that line', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const add = useMutation({
    mutationFn: () =>
      addLiquidationLine(shipment.id, {
        expenseCategoryId: draft.expenseCategoryId,
        description: draft.description || null,
        amount: draft.amount,
        // A date-only input means midnight local; sent as an instant because
        // storage is UTC and the display layer renders Asia/Manila.
        spentAt: new Date(draft.spentAt).toISOString(),
        receiptId: draft.receiptId,
      }),
    onSuccess: () => {
      setDraft((current) => ({
        ...current,
        description: '',
        amount: '',
        receiptId: null,
        receiptFileName: null,
      }));
      onChanged();
    },
    onError: reportFailure,
  });

  const remove = useMutation({
    mutationFn: (lineId: string) => removeLiquidationLine(shipment.id, lineId),
    onSuccess: onChanged,
    onError: reportFailure,
  });

  return (
    <div className="space-y-3">
      {liquidation.lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">No expenses claimed yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {liquidation.lines.map((line) => (
            <li key={line.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0 space-y-1">
                <p className="truncate">
                  {line.expenseCategoryName ?? 'Expense'}
                  {line.description ? ` · ${line.description}` : ''}
                </p>
                <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                  <span>{formatDate(line.spentAt)}</span>
                  {line.receiptId ? (
                    <a
                      className="underline underline-offset-4"
                      href={receiptContentUrl(line.receiptId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {line.receiptFileName ?? 'Receipt'}
                    </a>
                  ) : line.requiresReceipt ? (
                    // The category says a receipt is expected. Stated, not
                    // enforced: a lost ferry ticket is a real thing, and the
                    // person approving is better placed to judge it than a
                    // validation rule.
                    <span className="text-destructive">No receipt attached</span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums">{formatMoney(line.amount)}</span>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
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
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="line-category" className="text-xs">
                Category
              </Label>
              <Select
                value={draft.expenseCategoryId}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, expenseCategoryId: value }))
                }
              >
                <SelectTrigger id="line-category">
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {(categories.data?.items ?? []).map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="line-amount" className="text-xs">
                Amount
              </Label>
              <Input
                id="line-amount"
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

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="line-spent-at" className="text-xs">
                Spent on
              </Label>
              <Input
                id="line-spent-at"
                type="date"
                required
                value={draft.spentAt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, spentAt: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="line-description" className="text-xs">
                Description
              </Label>
              <Input
                id="line-description"
                placeholder="Optional"
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </div>
          </div>

          <ReceiptField
            value={draft.receiptId}
            fileName={draft.receiptFileName}
            label="Attach receipt"
            onChange={(receiptId, fileName) =>
              setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
            }
          />

          <Button type="submit" size="sm" disabled={add.isPending || !draft.expenseCategoryId}>
            {add.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Add expense
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The four moves, and only the ones that are legal right now.
 *
 * Return and reverse each open a reason box before anything is sent, because
 * the reason is not optional and a dialog that asks afterwards is a dialog
 * somebody dismisses.
 */
function Actions({
  shipment,
  liquidation,
  canDecide,
  onChanged,
}: {
  shipment: Shipment;
  liquidation: Liquidation;
  canDecide: boolean;
  onChanged: () => void;
}) {
  const [reasonFor, setReasonFor] = useState<'return' | 'reverse' | null>(null);
  const [reason, setReason] = useState('');

  const reportFailure = (error: unknown) =>
    toast.error('That did not go through', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const succeed = (message: string) => () => {
    toast.success(message);
    setReasonFor(null);
    setReason('');
    onChanged();
  };

  const submit = useMutation({
    mutationFn: () => submitLiquidation(shipment.id, null),
    onSuccess: succeed('Sent to accounting'),
    onError: reportFailure,
  });

  const approve = useMutation({
    mutationFn: () => approveLiquidation(shipment.id, null),
    onSuccess: succeed('Approved — costs are now recognised'),
    onError: reportFailure,
  });

  const sendBack = useMutation({
    mutationFn: () => returnLiquidation(shipment.id, reason),
    onSuccess: succeed('Returned to the crew'),
    onError: reportFailure,
  });

  const reverse = useMutation({
    mutationFn: () => reverseLiquidation(shipment.id, reason),
    onSuccess: succeed('Approval reversed'),
    onError: reportFailure,
  });

  const busy = submit.isPending || approve.isPending || sendBack.isPending || reverse.isPending;

  if (reasonFor) {
    const isReturn = reasonFor === 'return';

    return (
      <form
        className="space-y-3 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          (isReturn ? sendBack : reverse).mutate();
        }}
      >
        <Label htmlFor="liquidation-reason" className="text-xs">
          {isReturn
            ? 'Why is this going back? The crew see this.'
            : 'Why is the approval being reversed? This goes to the audit trail.'}
        </Label>
        <Textarea
          id="liquidation-reason"
          required
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="destructive" disabled={busy || !reason.trim()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isReturn ? 'Return to crew' : 'Reverse approval'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReasonFor(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      {liquidation.status === LiquidationStatus.PENDING ? (
        <Button size="sm" disabled={busy} onClick={() => submit.mutate()}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Submit to accounting
        </Button>
      ) : null}

      {canDecide && liquidation.status === LiquidationStatus.SUBMITTED ? (
        <>
          <Button size="sm" disabled={busy} onClick={() => approve.mutate()}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setReasonFor('return')}>
            Return for correction
          </Button>
        </>
      ) : null}

      {canDecide && liquidation.status === LiquidationStatus.APPROVED ? (
        <Button size="sm" variant="outline" onClick={() => setReasonFor('reverse')}>
          Reverse approval
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Every submission and every return, oldest first.
 *
 * This is the record a status column cannot hold: both events leave the
 * liquidation somewhere it has been before, so without these rows a
 * twice-returned claim looks like a first submission.
 */
function History({ liquidation }: { liquidation: Liquidation }) {
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-muted-foreground text-xs font-medium">History</p>
      <ul className="space-y-2 text-sm">
        {liquidation.history.map((entry) => (
          <li key={entry.id} className="flex gap-2">
            <Badge
              variant={entry.action === LiquidationHistoryAction.RETURNED ? 'outline' : 'secondary'}
              className="h-fit shrink-0"
            >
              {LIQUIDATION_HISTORY_ACTION_LABELS[entry.action]}
            </Badge>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">
                {entry.actorName ?? 'Someone'} · {formatDateTime(entry.occurredAt)}
              </p>
              {entry.reason ? <p>{entry.reason}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
