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
 * HOW MUCH COMES BACK is asked separately from what was paid, because recovery
 * is routinely partial — a permit bought at ₱2,000 against a client who agreed
 * to ₱1,500. One field for both could only express full recovery, and the way
 * people worked around that was to type the smaller figure as the cost, which
 * then disagreed with the receipt attached to the same line.
 *
 * WHOSE MONEY PAID FOR A REBILL is asked on the form, because the P&L cannot
 * work it out afterwards. Office-paid means this row is the only record of the
 * money leaving, so it is a cost of the trip; crew-paid means picking the CLAIM
 * on their liquidation that already carries the cost, and counting it here too
 * would charge the trip twice for one permit. Both mistakes look like an
 * ordinary number on a screen, which is why the question is asked rather than
 * defaulted.
 *
 * THE CLAIM, NOT THE ACCOUNT, because an account is a promise and a claim is a
 * row. Offering the account let somebody defer a cost to a liquidation that
 * never filed the expense, and the cost was then counted nowhere at all —
 * billed to the client at what read as full margin. Claims already rebilled are
 * not offered, since one claim rebilled twice invoices the client twice.
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

/**
 * Whether a decimal string is zero, without parsing it as a number.
 *
 * "0.00", "0" and "-0.00" are all the same nothing, and the point of comparing
 * this way is that the browser never turns a money string into a float — the
 * same rule the API follows on the other side of the wire.
 */
function isZeroMoney(value: string): boolean {
  return /^-?0*(\.0*)?$/.test(value.trim());
}

function BillableExpenses({ shipment, canEdit }: { shipment: Shipment; canEdit: boolean }) {
  const invalidate = useChargeInvalidation();

  const [draft, setDraft] = useState({
    expenseCategoryId: '',
    description: '',
    amount: '',
    /** Blank means the whole amount — the API defaults it, so '' is honest. */
    billedAmount: '',
    spentAt: new Date().toISOString().slice(0, 10),
    payeeId: '',
    referenceNumber: '',
    isCommissionable: false,
    receiptId: null as string | null,
    receiptFileName: null as string | null,
    /** '' is the office. Otherwise the id of the claim carrying the cost. */
    liquidationLineId: '',
  });

  const lines = useQuery({
    queryKey: shipmentKeys.billableExpenses(shipment.id),
    queryFn: () => listBillableExpenses(shipment.id),
  });

  const categories = useQuery({
    // Trip categories only. Unfiltered, this picker offered the office lease.
    queryKey: ['expense-categories', 'selectable', 'trips'],
    queryFn: () =>
      apiFetch<Page<ExpenseCategory>>('/expense-categories?pageSize=200&offeredFor=trips'),
    enabled: canEdit,
  });

  // The cash accounts open on this trip — one per pile of cash, plus the trip's
  // own, which exists from booking and has nobody's name on it yet.
  const accounts = useQuery({
    queryKey: liquidationKeys.liquidations(shipment.id),
    queryFn: () => listShipmentLiquidations(shipment.id),
    enabled: canEdit,
  });

  /**
   * Every crew claim on this trip that is free to be rebilled, flattened out of
   * the accounts and labelled with the one they sit on.
   *
   * ALREADY-REBILLED CLAIMS ARE FILTERED OUT, because offering one is offering
   * to invoice the client twice for a cost the crew incurred once. The API
   * refuses it and the database refuses it — this only keeps the impossible
   * choice off the screen. The claim being EDITED is exempt, or reopening a
   * saved row would find its own claim missing from the list.
   */
  const rebilledClaimIds = new Set(
    (lines.data ?? [])
      .map((line) => line.liquidationLineId)
      .filter((value): value is string => value !== null),
  );

  const claims = (accounts.data ?? []).flatMap((account) =>
    account.lines
      .filter((line) => !rebilledClaimIds.has(line.id))
      .map((line) => ({
        id: line.id,
        amount: line.amount,
        expenseCategoryName: line.expenseCategoryName,
        account: liquidationAccountLabel(
          account.custodianName,
          account.sequence,
          account.description,
        ),
      })),
  );

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
        // Omitted rather than defaulted here: the API fills it with the amount,
        // and copying that rule into the browser would be a second place for it
        // to be wrong.
        billedAmount: draft.billedAmount || undefined,
        // A date-only input means midnight local; sent as an instant because
        // storage is UTC and the display layer renders Asia/Manila.
        spentAt: new Date(draft.spentAt).toISOString(),
        isCommissionable: draft.isCommissionable,
        // '' is "nothing chosen"; the wire wants null.
        payeeId: draft.payeeId || null,
        liquidationLineId: draft.liquidationLineId || null,
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
        billedAmount: '',
        // Cleared, unlike the category and payee: a claim can be rebilled once,
        // so keeping it would leave the form pointing at the one option the
        // next line certainly cannot use.
        liquidationLineId: '',
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
                    {line.liquidationLineId
                      ? `Rebills a crew claim · ${line.liquidationCustodianName ?? 'unassigned account'} · counted there, not here`
                      : 'Paid by the office · a cost of this trip'}
                  </p>
                  {/* THE FIGURE THE P&L ACTUALLY CHARGES IS THE CLAIM'S, so a
                      rebill disagreeing with it is worth seeing: this row says
                      one thing was paid and the trip is costed another. Shown
                      only when they differ, and worded as a comparison rather
                      than an error — rebilling part of a larger claim is an
                      ordinary thing to do, and the amber is there to make it a
                      deliberate choice rather than a silent one. */}
                  {line.liquidationVariance !== null && !isZeroMoney(line.liquidationVariance) ? (
                    <p className="text-xs text-amber-600">
                      {formatMoney(line.liquidationVariance.replace('-', ''))}{' '}
                      {line.liquidationVariance.startsWith('-') ? 'less' : 'more'} than the claim,
                      which is {formatMoney(line.liquidationLineAmount ?? '0')}
                    </p>
                  ) : null}
                  {line.receiptFileName ? (
                    <p className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Paperclip className="h-3 w-3" />
                      {line.receiptFileName}
                    </p>
                  ) : null}
                  {line.isCommissionable ? <Badge variant="secondary">Commissionable</Badge> : null}
                </div>
                <div className="flex shrink-0 items-start gap-2">
                  {/* The BILLED figure leads, because this list sits beside the
                      revenue it makes up. What was paid is shown under it only
                      when the two differ — printing "₱1,500 · paid ₱1,500" on
                      every fully recovered line would bury the handful that
                      actually lost money. */}
                  <span className="text-right">
                    <span className="tabular-nums">{formatMoney(line.billedAmount)}</span>
                    {line.billedAmount !== line.amount ? (
                      <span className="text-muted-foreground block text-xs tabular-nums">
                        paid {formatMoney(line.amount)}
                      </span>
                    ) : null}
                  </span>
                  {canEdit ? (
                    <ConfirmDeleteButton
                      label={`Remove ${line.expenseCategoryName ?? line.description ?? 'expense'}`}
                      title="Remove this billable expense?"
                      description={
                        line.isCommissionable
                          ? 'It stops being rebilled to the client, and the crew’s commission base drops by its amount — recompute commissions afterwards.'
                          : line.liquidationLineId
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
                  Amount paid
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

            {/* LEFT BLANK IS FULL RECOVERY, which is the ordinary case and so
                should cost nothing to express. Pre-filling it with the amount
                would look the same but behave worse: the two would then have to
                be kept in step while somebody edited the first, and a stale
                copy left behind is a discount nobody agreed to. */}
            <div className="space-y-1">
              <Label htmlFor="billable-billed" className="text-xs">
                Billed to client
              </Label>
              <Input
                id="billable-billed"
                placeholder={draft.amount ? `${draft.amount} (the full amount)` : 'The full amount'}
                inputMode="decimal"
                value={draft.billedAmount}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, billedAmount: event.target.value }))
                }
              />
              <p className="text-muted-foreground text-xs">
                Leave blank to recover all of it. A smaller figure is the part the client agreed to
                — the rest stays with the company as cost.
              </p>
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
                value={draft.liquidationLineId || OFFICE_PAID}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    liquidationLineId: value === OFFICE_PAID ? '' : value,
                  }))
                }
              >
                <SelectTrigger id="billable-paid-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OFFICE_PAID}>Company funds</SelectItem>
                  {claims.map((claim) => (
                    <SelectItem key={claim.id} value={claim.id}>
                      {claim.account} · {claim.expenseCategoryName ?? 'Expense'} ·{' '}
                      {formatMoney(claim.amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {draft.liquidationLineId
                  ? 'The cost is already counted on that claim, so this line is revenue only.'
                  : claims.length === 0
                    ? 'This line is the record of the money leaving, so it counts as a cost too. No crew claims are available to rebill on this trip.'
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
