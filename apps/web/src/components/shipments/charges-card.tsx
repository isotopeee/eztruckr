'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  liquidationAccountLabel,
  UserRole,
  type ExpenseCategory,
  type Page,
  type Shipment,
} from '@eztruckr/types';
import { Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { PayeeField } from '@/components/shipments/payee-field';
import { ReceiptField } from '@/components/shipments/receipt-field';
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
import { Switch } from '@/components/ui/switch';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { liquidationKeys, listShipmentLiquidations } from '@/lib/liquidation-api';
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

/**
 * Billable expenses and additional charges.
 *
 * Kept as two lists rather than one with a type column, because they are two
 * different things to the P&L: a billable expense is a cost somebody paid and
 * the client repays, so it lands on both sides; an additional charge has no
 * underlying cost and is pure revenue. Merging them in the UI would invite
 * merging them in the reporting.
 *
 * WHOSE MONEY PAID FOR A REBILL is asked on the form, because the P&L cannot
 * work it out afterwards. Office-paid means this row is the only record of the
 * money leaving, so it is a cost of the trip; crew-paid means the cost arrives
 * on their liquidation and counting it here too would charge the trip twice for
 * one permit. Both mistakes look like an ordinary number on a screen, which is
 * why the question is asked rather than defaulted.
 *
 * TWO DIFFERENT FORMS, for the same reason. A billable expense is money that
 * actually left somebody's hands, so it asks everything the company-paid card
 * asks — category, date, payee, reference, receipt — and the two screens no
 * longer disagree about what is worth recording about one permit fee. An
 * additional charge is a line on an invoice with no cost behind it, so there is
 * no date it was paid, nobody it was paid to, and no receipt to attach.
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
      <BillableExpenses shipment={shipment} canEdit={canEdit} />
      <AdditionalCharges shipment={shipment} canEdit={canEdit} />
    </div>
  );
}

/** Invalidates everything: gross profit and the commission base read these. */
function useChargeInvalidation() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };
}

function reportFailure(error: unknown) {
  toast.error('Could not save the line', {
    description: error instanceof ApiError ? error.displayMessage : String(error),
  });
}

/**
 * The "no account" option, because a Radix `SelectItem` cannot carry an empty
 * value — it uses '' internally for "nothing selected". A sentinel keeps the
 * office the visibly chosen answer rather than a blank trigger that reads as an
 * unanswered question.
 */
const OFFICE_PAID = 'office';

function BillableExpenses({ shipment, canEdit }: { shipment: Shipment; canEdit: boolean }) {
  const invalidate = useChargeInvalidation();

  const [draft, setDraft] = useState({
    expenseCategoryId: '',
    description: '',
    amount: '',
    spentAt: new Date().toISOString().slice(0, 10),
    payeeId: '',
    referenceNumber: '',
    isCommissionable: false,
    receiptId: null as string | null,
    receiptFileName: null as string | null,
    /** '' is the office. An account id is the crew member holding the cash. */
    liquidationId: '',
  });

  const lines = useQuery({
    queryKey: shipmentKeys.billableExpenses(shipment.id),
    queryFn: () => listBillableExpenses(shipment.id),
  });

  const categories = useQuery({
    queryKey: ['expense-categories', 'selectable'],
    queryFn: () => apiFetch<Page<ExpenseCategory>>('/expense-categories?pageSize=200'),
    enabled: canEdit,
  });

  // The cash accounts open on this trip — one per pile of cash, plus the trip's
  // own, which exists from booking and has nobody's name on it yet.
  const accounts = useQuery({
    queryKey: liquidationKeys.liquidations(shipment.id),
    queryFn: () => listShipmentLiquidations(shipment.id),
    enabled: canEdit,
  });

  // The chosen category decides whether a payee is required. Unknown until one
  // is picked, and false rather than true then: the field should not demand
  // something before the rule that demands it has been chosen.
  const payeeRequired =
    categories.data?.items.find((category) => category.id === draft.expenseCategoryId)
      ?.requiresPayee ?? false;

  const add = useMutation({
    mutationFn: () =>
      addBillableExpense(shipment.id, {
        expenseCategoryId: draft.expenseCategoryId || null,
        description: draft.description || null,
        amount: draft.amount,
        // A date-only input means midnight local; sent as an instant because
        // storage is UTC and the display layer renders Asia/Manila.
        spentAt: new Date(draft.spentAt).toISOString(),
        isCommissionable: draft.isCommissionable,
        // '' is "nothing chosen"; the wire wants null.
        payeeId: draft.payeeId || null,
        liquidationId: draft.liquidationId || null,
        referenceNumber: draft.referenceNumber || null,
        receiptId: draft.receiptId,
      }),
    onSuccess: () => {
      // The category, payee, date and who paid are kept, as on the company-paid
      // card: several lines off one supplier invoice is the common case, and
      // re-picking the same vendor each time invites a wrong one. Who paid is
      // kept for a stronger reason — a run of lines off one crew member's cash
      // is exactly the case where re-picking each time gets one of them wrong,
      // and a wrong one there is a cost counted twice or not at all.
      setDraft((current) => ({
        ...current,
        description: '',
        amount: '',
        referenceNumber: '',
        receiptId: null,
        receiptFileName: null,
      }));
      invalidate();
    },
    onError: reportFailure,
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeBillableExpense(shipment.id, id),
    onSuccess: invalidate,
    onError: reportFailure,
  });

  const rows = lines.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Billable expenses</CardTitle>
        <CardDescription>
          Costs fronted and recovered from the client — permits, crane hire, port charges. Revenue
          always; a cost of the trip too when the office paid, rather than the crew out of cash they
          are holding.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No lines yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((line) => (
              <li key={line.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0 space-y-1">
                  <p className="truncate font-medium">
                    {line.expenseCategoryName ?? line.description ?? 'Expense'}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {formatDate(line.spentAt)}
                    {line.payeeName ? ` · ${line.payeeName}` : ''}
                    {/* Not repeated when it is already the heading above. */}
                    {line.description && line.expenseCategoryName ? ` · ${line.description}` : ''}
                    {line.referenceNumber ? ` · Ref ${line.referenceNumber}` : ''}
                  </p>
                  {/* Stated on every row, both ways round. Showing a badge only
                      for the crew-paid ones would make "office-paid" and "we
                      forgot to say" look identical, and those two differ by a
                      whole cost on the trip. An account with nobody's name on
                      it is the one delivery opens when none was ever made. */}
                  <p className="text-muted-foreground text-xs">
                    {line.liquidationId
                      ? `Paid from crew cash · ${line.liquidationCustodianName ?? 'unassigned account'} · liquidated, not a cost here`
                      : 'Paid by the office · a cost of this trip'}
                  </p>
                  {line.receiptFileName ? (
                    <p className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Paperclip className="h-3 w-3" />
                      {line.receiptFileName}
                    </p>
                  ) : null}
                  {line.isCommissionable ? <Badge variant="secondary">Commissionable</Badge> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatMoney(line.amount)}</span>
                  {canEdit ? (
                    <ConfirmDeleteButton
                      label={`Remove ${line.expenseCategoryName ?? line.description ?? 'expense'}`}
                      title="Remove this billable expense?"
                      description={
                        line.isCommissionable
                          ? 'It stops being rebilled to the client, and the crew’s commission base drops by its amount — recompute commissions afterwards.'
                          : line.liquidationId
                            ? 'It stops being rebilled to the client. The cost stays on the crew’s liquidation, which this line never counted.'
                            : 'It stops being rebilled to the client and leaves the trip’s revenue and cost.'
                      }
                      pending={remove.isPending}
                      onConfirm={() => remove.mutate(line.id)}
                    />
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
                <Label htmlFor="billable-category" className="text-xs">
                  Category
                </Label>
                <Select
                  value={draft.expenseCategoryId}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, expenseCategoryId: value }))
                  }
                >
                  <SelectTrigger id="billable-category">
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
                <Label htmlFor="billable-amount" className="text-xs">
                  Amount
                </Label>
                <Input
                  id="billable-amount"
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
                <Label htmlFor="billable-spent-at" className="text-xs">
                  Paid on
                </Label>
                <Input
                  id="billable-spent-at"
                  type="date"
                  required
                  value={draft.spentAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, spentAt: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="billable-description" className="text-xs">
                  Description
                </Label>
                <Input
                  id="billable-description"
                  placeholder="Optional"
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
            </div>

            <PayeeField
              id="billable-payee"
              value={draft.payeeId}
              required={payeeRequired}
              onChange={(payeeId) => setDraft((current) => ({ ...current, payeeId }))}
            />

            {/* WHOSE MONEY, which is the field that decides whether this line
                is a cost. Defaulted to the office rather than left empty: a
                required question with no answer blocks a form somebody is
                trying to finish, and of the two possible wrong defaults this is
                the one that fails loudly — an office-paid rebill wrongly linked
                drops a real cost off the trip with nothing on screen looking
                wrong, whereas a crew-paid one left here shows the same expense
                twice to anyone reading both cards. */}
            <div className="space-y-1">
              <Label htmlFor="billable-paid-from" className="text-xs">
                Paid from
              </Label>
              <Select
                value={draft.liquidationId || OFFICE_PAID}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    liquidationId: value === OFFICE_PAID ? '' : value,
                  }))
                }
              >
                <SelectTrigger id="billable-paid-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OFFICE_PAID}>Company funds</SelectItem>
                  {(accounts.data ?? []).map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {liquidationAccountLabel(
                        account.custodianName,
                        account.sequence,
                        account.description,
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {draft.liquidationId
                  ? 'The cost is counted on that liquidation, so this line is revenue only.'
                  : 'This line is the record of the money leaving, so it counts as a cost too.'}
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="billable-reference" className="text-xs">
                Reference
              </Label>
              <Input
                id="billable-reference"
                placeholder="Invoice or OR number (optional)"
                value={draft.referenceNumber}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, referenceNumber: event.target.value }))
                }
              />
            </div>

            <ReceiptField
              value={draft.receiptId}
              fileName={draft.receiptFileName}
              label="Attach receipt"
              onChange={(receiptId, fileName) =>
                setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
              }
            />

            <CommissionableSwitch
              id="billable-commissionable"
              checked={draft.isCommissionable}
              onChange={(isCommissionable) =>
                setDraft((current) => ({ ...current, isCommissionable }))
              }
            />

            {/* A category is required HERE but not by the API, and the split is
                deliberate: rows written before there was a category to pick
                have to stay patchable, while a new line typed today should not
                be the one nobody can report on. The same rule the company-paid
                form has always applied. */}
            <Button
              type="submit"
              size="sm"
              disabled={
                add.isPending || !draft.expenseCategoryId || (payeeRequired && !draft.payeeId)
              }
            >
              {add.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add expense
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AdditionalCharges({ shipment, canEdit }: { shipment: Shipment; canEdit: boolean }) {
  const invalidate = useChargeInvalidation();
  const [draft, setDraft] = useState({ description: '', amount: '', isCommissionable: false });

  const lines = useQuery({
    queryKey: shipmentKeys.additionalCharges(shipment.id),
    queryFn: () => listAdditionalCharges(shipment.id),
  });

  const add = useMutation({
    mutationFn: () => addAdditionalCharge(shipment.id, draft),
    onSuccess: () => {
      setDraft({ description: '', amount: '', isCommissionable: false });
      invalidate();
    },
    onError: reportFailure,
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeAdditionalCharge(shipment.id, id),
    onSuccess: invalidate,
    onError: reportFailure,
  });

  const rows = lines.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Additional charges</CardTitle>
        <CardDescription>
          Fees with no underlying cost — extra drops, detention, surcharges. Pure revenue.
        </CardDescription>
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
                    <ConfirmDeleteButton
                      label={`Remove ${line.description}`}
                      title="Remove this charge?"
                      description={
                        line.isCommissionable
                          ? 'The trip’s revenue drops by its amount, and so does the crew’s commission base — recompute commissions afterwards.'
                          : 'The trip’s revenue drops by its amount.'
                      }
                      pending={remove.isPending}
                      onConfirm={() => remove.mutate(line.id)}
                    />
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
                <Label htmlFor="additional-description" className="sr-only">
                  Description
                </Label>
                <Input
                  id="additional-description"
                  placeholder="Description"
                  required
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
              <div className="w-32">
                <Label htmlFor="additional-amount" className="sr-only">
                  Amount
                </Label>
                <Input
                  id="additional-amount"
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

            <CommissionableSwitch
              id="additional-commissionable"
              checked={draft.isCommissionable}
              onChange={(isCommissionable) =>
                setDraft((current) => ({ ...current, isCommissionable }))
              }
            />

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

/** Labelled with its consequence, not its name — it is what the crew are paid on. */
function CommissionableSwitch({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-muted-foreground text-xs font-normal">
        Commissionable — include in the crew&apos;s commission base
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
