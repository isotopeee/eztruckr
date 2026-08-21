'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALLOWANCE_REQUEST_STATUS_LABELS,
  AllowanceRequestStatus,
  DISBURSEMENT_MODE_LABELS,
  DisbursementMode,
  LiquidationStatus,
  UserRole,
  expectsProofOfRelease,
  expectsReferenceNumber,
  type AllowanceRequest,
  type Liquidation,
  type Shipment,
} from '@eztruckr/types';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  approveAllowanceRequest,
  createAllowanceRequest,
  declineAllowanceRequest,
  liquidationKeys,
  listAllowanceRequests,
  listShipmentLiquidations,
  updateAllowanceRequest,
  withdrawAllowanceRequest,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { ReceiptField } from './receipt-field';
import { useTripCashHolders } from './trip-cash-holders';

/**
 * Dispatch asking accounting for this trip's cash, and accounting's answer.
 *
 * TWO AUDIENCES, ONE CARD, and which half you see is your role. A dispatch
 * manager gets the form and can withdraw an ask nobody has answered; accounting
 * gets Approve and Decline on anything still waiting. Everyone with a desk reads
 * the list, because "has the driver been given money yet" is a question the
 * whole office asks.
 *
 * IT SITS ABOVE THE ALLOWANCES CARD BECAUSE THAT IS THE ORDER IT HAPPENS IN.
 * An approval here becomes an ordinary release down there — same account, same
 * total advanced — so the two cards are one story read top to bottom, and this
 * one deliberately does not restate the money side of it.
 */
export function AllowanceRequestsCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  // Mirrors CAN_REQUEST_ALLOWANCE and CAN_DECIDE_ALLOWANCE_REQUEST on the API.
  // Hiding a control is a courtesy; the guard is the server's, and a role that
  // slips past this still gets a 403.
  const canRequest =
    user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.DISPATCH_MANAGER;
  const canDecide = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const requests = useQuery({
    queryKey: liquidationKeys.allowanceRequests(shipment.id),
    queryFn: () => listAllowanceRequests(shipment.id),
  });

  // Shares a cache key with the liquidation and allowances cards, so all three
  // on one screen cost one request rather than three.
  const accounts = useQuery({
    queryKey: liquidationKeys.liquidations(shipment.id),
    queryFn: () => listShipmentLiquidations(shipment.id),
  });

  /**
   * Everything, because an approval moves more than this list: it writes a
   * release, which moves the custodian's total advanced and their variance, and
   * the shipment's own summary alongside it.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: liquidationKeys.all });
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawAllowanceRequest(shipment.id, id),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not withdraw that request', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const rows = requests.data ?? [];
  const waiting = rows.filter((row) => row.status === AllowanceRequestStatus.PENDING);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Allowance requests</CardTitle>
        <CardDescription>
          Dispatch asks, accounting releases. An approval records an ordinary cash release against
          the same account — it appears under Allowances, counted in the total advanced.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {waiting.length > 0 ? (
          <div className="flex items-baseline justify-between border-b pb-3">
            <span className="text-muted-foreground text-sm">
              {canDecide ? 'Waiting on you' : 'Waiting on accounting'}
            </span>
            {/* A COUNT, NOT A TOTAL. The web app never adds money up — every
                figure it shows is a decimal string the API computed — and a
                total of things nobody has agreed to release would read like a
                liability besides. Each row carries its own amount. */}
            <span className="text-lg font-semibold tabular-nums">
              {waiting.length} request{waiting.length === 1 ? '' : 's'}
            </span>
          </div>
        ) : null}

        {requests.isPending ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing requested on this trip.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                shipment={shipment}
                accounts={accounts.data ?? []}
                canDecide={canDecide}
                canEdit={canRequest}
                withdrawing={withdraw.isPending}
                onWithdraw={() => withdraw.mutate(request.id)}
                onChanged={invalidate}
              />
            ))}
          </ul>
        )}

        {canRequest ? (
          <RequestForm
            shipment={shipment}
            accounts={accounts.data ?? []}
            onRequested={invalidate}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestRow({
  request,
  shipment,
  accounts,
  canDecide,
  canEdit,
  withdrawing,
  onWithdraw,
  onChanged,
}: {
  request: AllowanceRequest;
  shipment: Shipment;
  accounts: Liquidation[];
  canDecide: boolean;
  /** Raising, correcting and withdrawing are one permission — see the API. */
  canEdit: boolean;
  withdrawing: boolean;
  onWithdraw: () => void;
  onChanged: () => void;
}) {
  const pending = request.status === AllowanceRequestStatus.PENDING;

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate">
            {request.staffName ?? 'Crew'} · {formatDateTime(request.requestedAt)}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={pending ? 'default' : 'outline'}>
              {ALLOWANCE_REQUEST_STATUS_LABELS[request.status]}
            </Badge>
            <span>
              on{' '}
              {request.custodianName
                ? `${request.custodianName}'s account`
                : 'the unassigned account'}
            </span>
            {request.requestedByName ? <span>asked by {request.requestedByName}</span> : null}
            {/* Said out loud, because approval carries no amount of its own to
                check against: accounting reads a figure, walks to the safe, and
                clicks. If dispatch revised it in between, this is the only
                thing on the row that says so. */}
            {request.editedAfterRaising ? (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <Pencil className="h-3 w-3" />
                Edited since it was raised
              </span>
            ) : null}
            {request.decidedByName ? (
              <span>
                {request.status === AllowanceRequestStatus.APPROVED ? 'released' : 'declined'} by{' '}
                {request.decidedByName}
              </span>
            ) : null}
          </div>
          {/* Always present, so no conditional: the purpose IS the ask, and a
              row that could render without one would be a request accounting
              is expected to decide on from a number alone. */}
          <p className="text-muted-foreground text-xs">{request.purpose}</p>
          {/* The reason is the entire content of a refusal going back to
              dispatch, so it is not tucked behind a hover or a detail view. */}
          {request.decisionReason ? (
            <p className="text-destructive text-xs">Declined: {request.decisionReason}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="tabular-nums">{formatMoney(request.amount)}</span>
          {pending && canEdit ? (
            <EditDialog
              request={request}
              shipment={shipment}
              accounts={accounts}
              onEdited={onChanged}
            />
          ) : null}
          {pending && canEdit ? (
            <ConfirmDeleteButton
              label="Withdraw request"
              title="Withdraw this request?"
              description={`${formatMoney(request.amount)} for ${
                request.staffName ?? 'the crew'
              } stops waiting on accounting. Nothing has been released, so nothing is undone — raise a new request if the trip still needs the cash.`}
              confirmLabel="Withdraw"
              pending={withdrawing}
              onConfirm={onWithdraw}
            />
          ) : null}
        </div>
      </div>

      {pending && canDecide ? (
        <div className="flex flex-wrap gap-2">
          <ApproveDialog request={request} onDecided={onChanged} />
          <DeclineDialog request={request} onDecided={onChanged} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Correcting an ask nobody has answered yet.
 *
 * THE SAME FOUR FIELDS THE REQUEST FORM ASKS FOR, seeded from the row. Not a
 * subset: the commonest correction is the one that changes which account it
 * lands on, and a dialog that only let you retype the amount would send people
 * back to withdraw-and-re-raise for the case they most need it.
 *
 * SENDS THE WHOLE SET rather than a diff. The endpoint is `.partial()`, so a
 * diff would work — but the form already holds every current value, and
 * computing which of four changed is an opportunity to get it wrong for no gain.
 *
 * ONLY WHILE PENDING. The row hides this once a decision exists, and the API
 * refuses it there regardless: editing a decided request would rewrite what
 * accounting answered.
 */
function EditDialog({
  request,
  shipment,
  accounts,
  onEdited,
}: {
  request: AllowanceRequest;
  shipment: Shipment;
  accounts: Liquidation[];
  onEdited: () => void;
}) {
  const [open, setOpen] = useState(false);
  const crew = useTripCashHolders(shipment);

  const [draft, setDraft] = useState({
    liquidationId: request.liquidationId,
    staffId: request.staffId,
    amount: request.amount,
    purpose: request.purpose,
  });

  // The account it is ALREADY on stays offered even if it has since been
  // approved, so the dropdown never silently swaps the answer out from under
  // somebody who only wanted to fix a typo. The API refuses the save with a
  // sentence, which is a better place to learn it than a field that changed
  // itself.
  const selectable = accounts.filter(
    (account) =>
      account.status !== LiquidationStatus.APPROVED || account.id === request.liquidationId,
  );

  const save = useMutation({
    mutationFn: () =>
      updateAllowanceRequest(shipment.id, request.id, {
        liquidationId: draft.liquidationId,
        staffId: draft.staffId,
        amount: draft.amount,
        purpose: draft.purpose,
      }),
    onSuccess: () => {
      setOpen(false);
      onEdited();
    },
    onError: (error: unknown) =>
      toast.error('Could not save that change', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Edit request"
        onClick={() => setOpen(true)}
      >
        <Pencil className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit this request</DialogTitle>
            <DialogDescription>
              Nobody has answered it yet, so it can still be corrected. The row will show that it
              was changed, because accounting may already have read the original.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`edit-account-${request.id}`} className="text-xs">
                Booked against
              </Label>
              <Select
                value={draft.liquidationId}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, liquidationId: value }))
                }
              >
                <SelectTrigger id={`edit-account-${request.id}`}>
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {selectable.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.custodianName ?? 'Unassigned account'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`edit-crew-${request.id}`} className="text-xs">
                  Cash goes to
                </Label>
                <Select
                  value={draft.staffId}
                  onValueChange={(value) => setDraft((current) => ({ ...current, staffId: value }))}
                >
                  <SelectTrigger id={`edit-crew-${request.id}`}>
                    <SelectValue placeholder="Crew member" />
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
              </div>
              <div className="space-y-1">
                <Label htmlFor={`edit-amount-${request.id}`} className="text-xs">
                  Amount
                </Label>
                <Input
                  id={`edit-amount-${request.id}`}
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
              <Label htmlFor={`edit-purpose-${request.id}`} className="text-xs">
                What it is for
              </Label>
              <Input
                id={`edit-purpose-${request.id}`}
                required
                value={draft.purpose}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, purpose: event.target.value }))
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                save.isPending ||
                draft.purpose.trim().length === 0 ||
                draft.amount.trim().length === 0
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Approving: how the money moved, and what proves it.
 *
 * NO AMOUNT FIELD. Approval releases what was asked for — releasing less is a
 * refusal of this request, not an approval of a different one, and it goes back
 * as a decline so dispatch can raise an ask they can live with. A row saying
 * "approved" beside a figure nobody agreed to is exactly what this record
 * exists to prevent.
 *
 * PROOF IS REQUIRED FOR A TRANSFER OR A WALLET PAYMENT, and the button says so
 * before it refuses. Both rails produce a document as a side effect of
 * happening, so there is nothing to invent; cash in the yard produces nothing,
 * and demanding an attachment there is how a photograph of a blank page ends up
 * looking like evidence.
 */
function ApproveDialog({
  request,
  onDecided,
}: {
  request: AllowanceRequest;
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    disbursementMode: String(DisbursementMode.CASH),
    referenceNumber: '',
    receiptId: null as string | null,
    receiptFileName: null as string | null,
    // Today, and editable: cash paid out on Friday is routinely typed up on
    // Monday, and a release dated the day it was recorded misstates when the
    // crew actually had the money.
    issuedAt: new Date().toISOString().slice(0, 10),
    remarks: '',
  });

  const mode = Number(draft.disbursementMode) as DisbursementMode;
  const proofRequired = expectsProofOfRelease(mode);
  const missingProof = proofRequired && draft.receiptId === null;

  const approve = useMutation({
    mutationFn: () =>
      approveAllowanceRequest(request.id, {
        disbursementMode: mode,
        referenceNumber: draft.referenceNumber || null,
        receiptId: draft.receiptId,
        // A date-only input means midnight local; sent as an instant, because
        // storage is UTC and the display layer renders Asia/Manila.
        issuedAt: new Date(draft.issuedAt).toISOString(),
        releasedBy: null,
        remarks: draft.remarks || null,
      }),
    onSuccess: () => {
      setOpen(false);
      onDecided();
    },
    onError: (error: unknown) =>
      toast.error('Could not approve that request', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Check className="mr-2 h-4 w-4" />
        Approve
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Release {formatMoney(request.amount)}?</DialogTitle>
            <DialogDescription>
              To {request.staffName ?? 'the crew'}, against{' '}
              {request.custodianName
                ? `${request.custodianName}'s account`
                : 'the unassigned account'}
              . This records the cash release itself — the amount is the one that was requested.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`approve-mode-${request.id}`} className="text-xs">
                  Released by
                </Label>
                <Select
                  value={draft.disbursementMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, disbursementMode: value }))
                  }
                >
                  <SelectTrigger id={`approve-mode-${request.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(DisbursementMode).map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {DISBURSEMENT_MODE_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`approve-issued-${request.id}`} className="text-xs">
                  Released on
                </Label>
                <Input
                  id={`approve-issued-${request.id}`}
                  type="date"
                  required
                  value={draft.issuedAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, issuedAt: event.target.value }))
                  }
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`approve-reference-${request.id}`} className="text-xs">
                Reference
              </Label>
              <Input
                id={`approve-reference-${request.id}`}
                // Never required, whatever the mode: a reference is TYPED, so
                // insisting on one produces "N/A". The attachment below is
                // UPLOADED, which is why that one is a rule and this is a prompt.
                placeholder={expectsReferenceNumber(mode) ? 'Transaction reference' : 'Optional'}
                value={draft.referenceNumber}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, referenceNumber: event.target.value }))
                }
              />
            </div>

            <Input
              placeholder="Remarks (optional)"
              value={draft.remarks}
              onChange={(event) =>
                setDraft((current) => ({ ...current, remarks: event.target.value }))
              }
            />

            <ReceiptField
              value={draft.receiptId}
              fileName={draft.receiptFileName}
              label={proofRequired ? 'Attach proof (required)' : 'Attach proof'}
              onChange={(receiptId, fileName) =>
                setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
              }
            />
            {missingProof ? (
              <p className="text-destructive text-[11px]">
                A {DISBURSEMENT_MODE_LABELS[mode].toLowerCase()} already produced a confirmation.
                Attach it — it is what ties the money to the person who asked for it.
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={approve.isPending || missingProof}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Approve and release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Refusing, with the reason that lets dispatch raise an ask they can live with. */
function DeclineDialog({
  request,
  onDecided,
}: {
  request: AllowanceRequest;
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const decline = useMutation({
    mutationFn: () => declineAllowanceRequest(request.id, { reason }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      onDecided();
    },
    onError: (error: unknown) =>
      toast.error('Could not decline that request', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <X className="mr-2 h-4 w-4" />
        Decline
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline {formatMoney(request.amount)}?</DialogTitle>
            <DialogDescription>
              Nothing is released. The reason goes back to whoever asked, so say what would make a
              new request payable — a smaller figure, a different account, paperwork still missing.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            placeholder="Why this is being refused"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={decline.isPending || reason.trim().length === 0}
              onClick={() => decline.mutate()}
            >
              {decline.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Raising one.
 *
 * ASKS THE SAME TWO QUESTIONS A RELEASE DOES — whose account, and who the cash
 * is for — because they are not the same question and flattening them would
 * lose one. A helper can be sent ferry money the driver still answers for.
 *
 * WHAT IT DOES NOT ASK IS HOW THE MONEY MOVES. Cash, transfer or wallet is
 * accounting's to choose when they pay; putting it here would mean an ask
 * approved by a rail the approver does not use.
 */
function RequestForm({
  shipment,
  accounts,
  onRequested,
}: {
  shipment: Shipment;
  accounts: Liquidation[];
  onRequested: () => void;
}) {
  const crew = useTripCashHolders(shipment);

  // Only accounts that could take the release. An approved one has its total
  // advanced frozen, so offering it here would put the refusal after the typing
  // rather than before it.
  const open = accounts.filter((account) => account.status !== LiquidationStatus.APPROVED);

  const [draft, setDraft] = useState({
    liquidationId: '',
    staffId: '',
    amount: '',
    purpose: '',
  });

  // Resolved on every render rather than seeded into `useState`: the accounts
  // and the crew list arrive after this form first mounts, and state seeded
  // from an empty list stays empty once it fills.
  const liquidationId = draft.liquidationId || (open[0]?.id ?? '');
  const staffId = draft.staffId || (crew[0]?.id ?? '');

  const raise = useMutation({
    mutationFn: () =>
      createAllowanceRequest(shipment.id, {
        liquidationId,
        staffId,
        amount: draft.amount,
        purpose: draft.purpose,
      }),
    onSuccess: () => {
      setDraft((current) => ({ ...current, amount: '', purpose: '' }));
      onRequested();
    },
    onError: (error: unknown) =>
      toast.error('Could not raise that request', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  if (crew.length === 0) {
    return (
      <p className="text-muted-foreground border-t pt-4 text-xs">
        Assign a driver before requesting cash — a request names the person it is for.
      </p>
    );
  }

  if (open.length === 0) {
    return (
      <p className="text-muted-foreground border-t pt-4 text-xs">
        No account on this trip can take a release: every liquidation is approved, or the trip is
        closed. Accounting can reverse an approval, with a reason.
      </p>
    );
  }

  return (
    <form
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        raise.mutate();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="request-account" className="text-xs">
          Booked against
        </Label>
        <Select
          value={liquidationId}
          onValueChange={(value) => setDraft((current) => ({ ...current, liquidationId: value }))}
        >
          <SelectTrigger id="request-account">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            {open.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.custodianName ?? 'Unassigned account'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-[11px]">
          Whose variance this would move. Not necessarily the person it is handed to.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          {/* NOT "Released to", which is the release form's label for the same
              person: nothing has been released at the point somebody is asking
              for it, and borrowing the word would describe a payment that has
              not happened. Not "For" either — it was too vague to distinguish
              from "Booked against" beside it, which is the one distinction this
              form exists to make. */}
          <Label htmlFor="request-crew" className="text-xs">
            Cash goes to
          </Label>
          <Select
            value={staffId}
            onValueChange={(value) => setDraft((current) => ({ ...current, staffId: value }))}
          >
            <SelectTrigger id="request-crew">
              <SelectValue placeholder="Crew member" />
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
        </div>
        <div className="space-y-1">
          <Label htmlFor="request-amount" className="text-xs">
            Amount
          </Label>
          <Input
            id="request-amount"
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
        <Label htmlFor="request-purpose" className="text-xs">
          What it is for
        </Label>
        <Input
          id="request-purpose"
          placeholder="Fuel and toll for the Batangas run"
          required
          value={draft.purpose}
          onChange={(event) => setDraft((current) => ({ ...current, purpose: event.target.value }))}
        />
        <p className="text-muted-foreground text-[11px]">
          Accounting decides on this. They are not running the trip, so a figure with no reason
          beside it is a decision made on the number alone.
        </p>
      </div>

      <Button
        type="submit"
        size="sm"
        disabled={
          raise.isPending || !liquidationId || !staffId || draft.purpose.trim().length === 0
        }
      >
        {raise.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Request allowance
      </Button>
    </form>
  );
}
