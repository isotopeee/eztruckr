'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isConfinedToTheirOwnFloat,
  liquidationAccountLabel,
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
import { AlertTriangle, Loader2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
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
  createLiquidation,
  liquidationKeys,
  listShipmentLiquidations,
  receiptContentUrl,
  removeLiquidation,
  removeLiquidationLine,
  returnLiquidation,
  reverseLiquidation,
  setLiquidationCustodian,
  setLiquidationDescription,
  setLiquidationReference,
  submitLiquidation,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { useTripCashHolders } from './trip-cash-holders';
import { PayeeField } from './payee-field';
import { ReceiptField } from './receipt-field';

/**
 * The liquidations: what the trip's cash was spent on, one account per pile of
 * it.
 *
 * ONE CARD, SEVERAL ACCOUNTS, AND THE SEPARATION IS THE POINT. A driver holding
 * ₱10,000 and a helper holding ₱3,000 each get their own figures, their own
 * status and their own four moves — approving the driver's does not touch, hurry
 * or speak for the helper's. Every action below sends a liquidation id, never a
 * shipment id, which is what makes that true rather than merely intended.
 *
 * AND SEVERAL OF THEM CAN BE ONE PERSON'S. A driver who draws a second advance
 * against a second voucher holds two piles of cash, squared up separately, so
 * the name at the top of a section stopped identifying it — `sequence` is what
 * does, through `liquidationAccountLabel`, here and in every refusal the API
 * sends back.
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

  const accounts = useQuery({
    queryKey: liquidationKeys.liquidations(shipment.id),
    queryFn: () => listShipmentLiquidations(shipment.id),
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: liquidationKeys.all });
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  if (accounts.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Liquidations</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  if (accounts.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Liquidations</CardTitle>
          <CardDescription>
            {accounts.error instanceof ApiError
              ? accounts.error.displayMessage
              : 'Could not load the liquidations.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const rows = accounts.data ?? [];
  const canDecide = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;
  // Opening an account, naming its custodian and removing an empty one are all
  // CAN_WRITE_SHIPMENT_MONEY on the API: deciding that a helper carries their
  // own cash is the same kind of call as releasing it, so a crew session cannot
  // open an account for itself.
  const canManageAccounts = canDecide;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Liquidations</CardTitle>
        <CardDescription>
          Expenses claimed against the cash advanced for this trip, one account per pile of it — one
          person can hold several, a voucher each. Costs reach the P&amp;L as each account is
          approved, and not before.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No cash accounts on this trip yet. One opens for the helper when the crew are assigned,
            and any other cash holder gets one below — an account arrives with the person answerable
            for it, not with the booking. A trip delivered without any gets an unnamed one, so the
            crew always have somewhere to file.
          </p>
        ) : (
          rows.map((account) => (
            <Account
              key={account.id}
              shipment={shipment}
              account={account}
              accountCount={rows.length}
              canDecide={canDecide}
              canManageAccounts={canManageAccounts}
              onChanged={invalidate}
            />
          ))
        )}

        {canManageAccounts ? (
          <OpenAccountForm shipment={shipment} accounts={rows} onOpened={invalidate} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One custodian's account, whole: whose it is, the four figures, the claims,
 * the moves that are legal right now, and its history.
 */
function Account({
  shipment,
  account,
  accountCount,
  canDecide,
  canManageAccounts,
  onChanged,
}: {
  shipment: Shipment;
  account: Liquidation;
  accountCount: number;
  canDecide: boolean;
  canManageAccounts: boolean;
  onChanged: () => void;
}) {
  const { user } = useCurrentUser();

  // Mirrors `assertMayAccountForThisFloat` on the API: anybody who can HOLD a
  // float may account for their own and nobody else's — a helper has no
  // business editing the driver's claims, and a dispatcher none editing a
  // colleague's. An account with nobody named to it — the one delivery opens
  // for a trip that arrived with none — is open to whoever is in a slot on it.
  // Only the two roles that hold no cash may act on any account, and the
  // history names whoever did.
  const confined = user !== null && isConfinedToTheirOwnFloat(user.role);
  const isTheirs = user?.staffId != null && account.custodianId === user.staffId;
  const onTheTruck =
    user?.staffId != null &&
    (shipment.driverId === user.staffId || shipment.helperId === user.staffId);
  const mayAccount = confined
    ? isTheirs || (account.custodianId === null && onTheTruck)
    : user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const canEditLines = account.isEditable && mayAccount;

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">
          {liquidationAccountLabel(account.custodianName, account.sequence, account.description)}
        </h3>
        <Badge variant={account.status === LiquidationStatus.APPROVED ? 'default' : 'secondary'}>
          {LIQUIDATION_STATUS_LABELS[account.status]}
        </Badge>
        {account.wasReturned ? <Badge variant="outline">Returned for correction</Badge> : null}
        {account.custodianId === null ? (
          <span className="text-muted-foreground text-xs">
            Created with the trip, before anybody was assigned
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {canManageAccounts && account.custodianId === null && account.isEditable ? (
            <CustodianPicker shipment={shipment} account={account} onChanged={onChanged} />
          ) : null}
          {/* Removal is for an account opened by mistake, so it is offered only
              while another remains: emptying a trip of all its accounts would
              leave nothing to liquidate against and nothing to recreate it
              until the next delivery. The API refuses one holding money. */}
          {canManageAccounts && account.isEditable && accountCount > 1 ? (
            <RemoveAccountButton account={account} onRemoved={onChanged} />
          ) : null}
        </div>
      </div>

      {account.latestReturnReason && account.status === LiquidationStatus.PENDING ? (
        <div className="border-destructive/40 bg-destructive/5 flex gap-3 rounded-md border p-3">
          <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Sent back for correction</p>
            <p className="text-muted-foreground">{account.latestReturnReason}</p>
          </div>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Figure label="Advanced" value={formatMoney(account.totalAllowance)} />
        <Figure label="Liquidated" value={formatMoney(account.totalLiquidated)} />
        <Figure
          label="Variance"
          value={formatMoney(account.variance)}
          hint={
            account.variance.startsWith('-') ? 'company reimburses crew' : 'crew return this cash'
          }
        />
        <Figure
          label="Recognised cost"
          value={formatMoney(account.recognisedCost)}
          hint={account.status === LiquidationStatus.APPROVED ? 'posted' : 'nothing posts yet'}
        />
      </dl>

      {/* What it is for, then the number it was settled under. In that order
          because the first is written when the account is opened and the second
          when the paperwork lands. */}
      <SelfSavingField
        id={`liquidation-description-${account.id}`}
        label="What this account is for"
        placeholder="Manila leg, second advance… (optional)"
        stored={account.description}
        canEdit={canEditLines}
        errorTitle="Could not save that description"
        save={(description) => setLiquidationDescription(account.id, { description })}
        onChanged={onChanged}
      />

      <SelfSavingField
        id={`liquidation-reference-${account.id}`}
        label="Reference"
        placeholder="Voucher or document number (optional)"
        stored={account.referenceNumber}
        canEdit={canEditLines}
        readOnlyPrefix="Reference "
        errorTitle="Could not save that reference"
        save={(referenceNumber) => setLiquidationReference(account.id, { referenceNumber })}
        onChanged={onChanged}
      />

      <Lines liquidation={account} canEdit={canEditLines} onChanged={onChanged} />

      <Actions
        liquidation={account}
        canDecide={canDecide}
        canSubmit={mayAccount}
        onChanged={onChanged}
      />

      {account.history.length > 0 ? <History liquidation={account} /> : null}
    </section>
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

/**
 * Naming who is answerable for an account that has nobody.
 *
 * Offered only while it has nobody, which is now one case: the account delivery
 * opens for a trip that reached the end without any, whose cash somebody was
 * holding all along. Renaming a custodian is a different act — the releases
 * already booked against the account stay where they are — and the API supports
 * it, but it is not something a screen should invite mid-trip.
 */
function CustodianPicker({
  shipment,
  account,
  onChanged,
}: {
  shipment: Shipment;
  account: Liquidation;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custodianId, setCustodianId] = useState('');
  const crew = useTripCashHolders(shipment);

  const assign = useMutation({
    mutationFn: () => setLiquidationCustodian(account.id, { custodianId }),
    onSuccess: () => {
      toast.success('Custodian named');
      setOpen(false);
      onChanged();
    },
    onError: (error: unknown) =>
      toast.error('Could not name a custodian', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  if (crew.length === 0) {
    return null;
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="mr-2 h-4 w-4" />
        Name custodian
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        assign.mutate();
      }}
    >
      <Select value={custodianId} onValueChange={setCustodianId}>
        <SelectTrigger aria-label="Custodian" className="h-8 w-52">
          <SelectValue placeholder="Who holds this cash?" />
        </SelectTrigger>
        <SelectContent>
          {crew.map((member) => (
            <SelectItem key={member.id} value={member.id}>
              {member.name}
              {member.note ? ` · ${member.note}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="submit" size="sm" disabled={assign.isPending || !custodianId}>
        {assign.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function RemoveAccountButton({
  account,
  onRemoved,
}: {
  account: Liquidation;
  onRemoved: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => removeLiquidation(account.id),
    onSuccess: () => {
      toast.success('Account removed');
      onRemoved();
    },
    // The refusal names what is holding it open — releases, claims, or an
    // approval — which is more use than anything this screen could pre-empt.
    onError: (error: unknown) =>
      toast.error('Could not remove that account', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  return (
    <ConfirmDeleteButton
      label="Remove account"
      title="Remove this account?"
      description={`${liquidationAccountLabel(
        account.custodianName,
        account.sequence,
        account.description,
      )} will no longer exist on this trip. The API refuses if any cash was released against it or anything has been claimed. Its NUMBER is not reused — the next account opened here gets the following one, so nothing that already named this one starts pointing somewhere else.`}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}

/**
 * A ONE-VALUE FIELD THAT SAVES ITSELF, rather than a form with a button.
 *
 * TWO OF THESE SIT ON AN ACCOUNT — the voucher reference and what the account
 * is for — and they are one component because they are one interaction: a
 * single value, typed off paperwork in the person's other hand or out of their
 * head, committed when they look away. An unchanged value sends nothing, and a
 * refusal puts back what the server still holds so the box never shows a value
 * that was rejected. Written twice, one copy would eventually forget that last
 * part.
 *
 * Both are editable exactly as long as the claims are: approval freezes the
 * account, these included, and reversing it opens them again.
 *
 * `readOnlyPrefix` is what a frozen account shows instead of the input — and
 * omitting it means "show nothing", which is what the description does, because
 * the heading above already reads "Test Driver's account 2 (Manila leg)".
 */
function SelfSavingField({
  id,
  label,
  placeholder,
  stored,
  canEdit,
  readOnlyPrefix,
  errorTitle,
  save,
  onChanged,
}: {
  id: string;
  label: string;
  placeholder: string;
  stored: string | null;
  canEdit: boolean;
  readOnlyPrefix?: string;
  errorTitle: string;
  save: (value: string | null) => Promise<unknown>;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(stored ?? '');

  const commit = useMutation({
    mutationFn: () => save(value.trim() || null),
    onSuccess: onChanged,
    onError: (error: unknown) => {
      setValue(stored ?? '');
      toast.error(errorTitle, {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      });
    },
  });

  if (!canEdit) {
    return stored && readOnlyPrefix !== undefined ? (
      <p className="text-muted-foreground text-xs">
        {readOnlyPrefix}
        {stored}
      </p>
    ) : null;
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        className="sm:max-w-xs"
        placeholder={placeholder}
        value={value}
        disabled={commit.isPending}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value.trim() === (stored ?? '')) return;
          commit.mutate();
        }}
      />
    </div>
  );
}

/**
 * Opening another account — for a second cash holder, or a second voucher
 * belonging to somebody who already holds one.
 *
 * EVERYBODY WHO MAY HOLD THIS TRIP'S CASH IS LISTED, including people who
 * already have an account here. They used to be filtered out, because the API
 * refused them; it stopped refusing when a long haul needed two vouchers for one
 * driver, and a picker that still hid them would be a screen enforcing a rule
 * that no longer exists.
 *
 * What a duplicate opened by accident costs is one click of Remove account,
 * which is offered while it is empty — and the count beside each name is there
 * so somebody notices before opening it rather than after.
 */
function OpenAccountForm({
  shipment,
  accounts,
  onOpened,
}: {
  shipment: Shipment;
  accounts: Liquidation[];
  onOpened: () => void;
}) {
  const [custodianId, setCustodianId] = useState('');
  const [description, setDescription] = useState('');

  const held = new Map<string, number>();
  for (const account of accounts) {
    if (account.custodianId !== null) {
      held.set(account.custodianId, (held.get(account.custodianId) ?? 0) + 1);
    }
  }

  const available = useTripCashHolders(shipment);

  const open = useMutation({
    // Asked for HERE rather than only on the card afterwards: the person
    // opening a second account for somebody who already has one is the person
    // who knows why, and a minute later they are somebody else.
    mutationFn: () =>
      createLiquidation(shipment.id, { custodianId, description: description.trim() || null }),
    onSuccess: () => {
      toast.success('Account opened');
      setCustodianId('');
      setDescription('');
      onOpened();
    },
    onError: (error: unknown) =>
      toast.error('Could not open that account', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  if (available.length === 0) {
    return null;
  }

  return (
    <form
      className="space-y-2 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        open.mutate();
      }}
    >
      <Label htmlFor="open-account" className="text-xs">
        Open another account
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={custodianId} onValueChange={setCustodianId}>
          <SelectTrigger id="open-account" className="w-56">
            <SelectValue placeholder="Crew or dispatch manager" />
          </SelectTrigger>
          <SelectContent>
            {available.map((member) => {
              const alreadyHolds = held.get(member.id) ?? 0;

              return (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                  {member.note ? ` · ${member.note}` : ''}
                  {alreadyHolds > 0
                    ? ` · already holds ${alreadyHolds} account${alreadyHolds === 1 ? '' : 's'} here`
                    : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Input
          className="w-56"
          aria-label="What this account is for"
          placeholder="What it is for (optional)"
          value={description}
          disabled={open.isPending}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={open.isPending || !custodianId}>
          {open.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Open account
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">
        Its own advances, its own variance, its own voucher — a second advance to the same person
        belongs here rather than on the account they are about to close. Cash somebody is handed can
        still be released against another account: who received it and who answers for it are
        separate facts.
      </p>
    </form>
  );
}

function Lines({
  liquidation,
  canEdit,
  onChanged,
}: {
  liquidation: Liquidation;
  canEdit: boolean;
  onChanged: () => void;
}) {
  // No `useCurrentUser()` here any more: this form asked for the role solely to
  // decide whether to show Paid To, and it no longer varies by who is looking.
  const [draft, setDraft] = useState({
    expenseCategoryId: '',
    description: '',
    amount: '',
    spentAt: new Date().toISOString().slice(0, 10),
    payeeId: '',
    receiptId: null as string | null,
    receiptFileName: null as string | null,
  });

  const categories = useQuery({
    // Trip categories only. Unfiltered, this picker offered the office lease.
    queryKey: ['expense-categories', 'selectable', 'trips'],
    queryFn: () =>
      apiFetch<Page<ExpenseCategory>>('/expense-categories?pageSize=200&offeredFor=trips'),
    enabled: canEdit,
  });

  // The chosen category decides whether a payee is required. Unknown until one
  // is picked, and false rather than true then.
  const payeeRequired =
    categories.data?.items.find((category) => category.id === draft.expenseCategoryId)
      ?.requiresPayee ?? false;

  /**
   * PAID TO IS ALWAYS SHOWN, to everyone. Only whether it is REQUIRED varies,
   * and `ExpenseCategory.requiresPayee` is the only thing that varies it.
   *
   * It used to be hidden from crew on optional categories, on the reasoning
   * that a driver filing a toll has no vendor to name. That produced a field
   * which appeared and disappeared as the category changed, and which the
   * office saw and the crew did not — two people looking at the same form and
   * disagreeing about what it contains. The company-expenses card never did
   * this, so the two disbursement forms behaved differently for no reason a
   * user could infer.
   *
   * The original concern is handled by the field itself rather than by hiding
   * it: when optional, `PayeeField` offers "Not recorded" and marks nothing
   * required, so there is an honest answer for the toll booth.
   */
  const reportFailure = (error: unknown) =>
    toast.error('Could not save that line', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const add = useMutation({
    mutationFn: () =>
      addLiquidationLine(liquidation.id, {
        expenseCategoryId: draft.expenseCategoryId,
        description: draft.description || null,
        amount: draft.amount,
        // A date-only input means midnight local; sent as an instant because
        // storage is UTC and the display layer renders Asia/Manila.
        spentAt: new Date(draft.spentAt).toISOString(),
        // '' is "nothing chosen"; the wire wants null. Read straight off the
        // draft now that the field is always visible — the gate that used to
        // sit here existed because the draft keeps the last payee on purpose,
        // so switching from a fuel line to a toll would have submitted the
        // filling station from a field the person could no longer see. It is
        // on screen now, so a stale value is theirs to notice and clear.
        payeeId: draft.payeeId || null,
        receiptId: draft.receiptId,
      }),
    onSuccess: () => {
      // The payee is deliberately kept: several lines against one station on
      // the same stop is the common case, and re-picking invites a wrong one.
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
    mutationFn: (lineId: string) => removeLiquidationLine(liquidation.id, lineId),
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
                  {line.payeeName ? <span>· {line.payeeName}</span> : null}
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
                  <ConfirmDeleteButton
                    label="Remove line"
                    title="Remove this claimed expense?"
                    description={`${formatMoney(line.amount)} comes off what this account has liquidated, so its variance grows by the same amount.`}
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
              <Label htmlFor={`line-category-${liquidation.id}`} className="text-xs">
                Category
              </Label>
              <Select
                value={draft.expenseCategoryId}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, expenseCategoryId: value }))
                }
              >
                <SelectTrigger id={`line-category-${liquidation.id}`}>
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
              <Label htmlFor={`line-amount-${liquidation.id}`} className="text-xs">
                Amount
              </Label>
              <Input
                id={`line-amount-${liquidation.id}`}
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
              <Label htmlFor={`line-spent-at-${liquidation.id}`} className="text-xs">
                Spent on
              </Label>
              <Input
                id={`line-spent-at-${liquidation.id}`}
                type="date"
                required
                value={draft.spentAt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, spentAt: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`line-description-${liquidation.id}`} className="text-xs">
                Description
              </Label>
              <Input
                id={`line-description-${liquidation.id}`}
                placeholder="Optional"
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </div>
          </div>

          <PayeeField
            id={`line-payee-${liquidation.id}`}
            value={draft.payeeId}
            required={payeeRequired}
            onChange={(payeeId) => setDraft((current) => ({ ...current, payeeId }))}
          />

          <ReceiptField
            value={draft.receiptId}
            fileName={draft.receiptFileName}
            label="Attach receipt"
            onChange={(receiptId, fileName) =>
              setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
            }
          />

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
    </div>
  );
}

/**
 * The four moves, and only the ones that are legal right now, on THIS account.
 *
 * Return and reverse each open a reason box before anything is sent, because
 * the reason is not optional and a dialog that asks afterwards is a dialog
 * somebody dismisses.
 */
function Actions({
  liquidation,
  canDecide,
  canSubmit,
  onChanged,
}: {
  liquidation: Liquidation;
  canDecide: boolean;
  canSubmit: boolean;
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
    mutationFn: () => submitLiquidation(liquidation.id, null),
    onSuccess: succeed('Sent to accounting'),
    onError: reportFailure,
  });

  const approve = useMutation({
    mutationFn: () => approveLiquidation(liquidation.id, null),
    onSuccess: succeed('Approved — costs are now recognised'),
    onError: reportFailure,
  });

  const sendBack = useMutation({
    mutationFn: () => returnLiquidation(liquidation.id, reason),
    onSuccess: succeed('Returned to the crew'),
    onError: reportFailure,
  });

  const reverse = useMutation({
    mutationFn: () => reverseLiquidation(liquidation.id, reason),
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
        <Label htmlFor={`liquidation-reason-${liquidation.id}`} className="text-xs">
          {isReturn
            ? 'Why is this going back? The crew see this.'
            : 'Why is the approval being reversed? This goes to the audit trail.'}
        </Label>
        <Textarea
          id={`liquidation-reason-${liquidation.id}`}
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

  const moves = [
    canSubmit && liquidation.status === LiquidationStatus.PENDING,
    canDecide && liquidation.status === LiquidationStatus.SUBMITTED,
    canDecide && liquidation.status === LiquidationStatus.APPROVED,
  ];

  if (!moves.some(Boolean)) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      {moves[0] ? (
        <Button size="sm" disabled={busy} onClick={() => submit.mutate()}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Submit to accounting
        </Button>
      ) : null}

      {moves[1] ? (
        <>
          <Button size="sm" disabled={busy} onClick={() => approve.mutate()}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setReasonFor('return')}>
            Return for correction
          </Button>
        </>
      ) : null}

      {moves[2] ? (
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
