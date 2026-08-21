'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_VERIFICATION_STATUS_LABELS,
  PaymentMethod,
  PaymentVerificationStatus,
  UserRole,
  expectsPaymentReference,
  type ClientPayment,
  type ClientPaymentSummary,
  type PaymentStatus,
  type RecordClientPaymentInput,
  type Shipment,
} from '@eztruckr/types';
import { AlertTriangle, BadgeCheck, Loader2, MessageCircleQuestion, Pencil } from 'lucide-react';
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
import { ApiError, receiptContentUrl } from '@/lib/api-client';
import { formatDate, formatMoney, toDateInputValue } from '@/lib/format';
import {
  getClientPayments,
  recordClientPayment,
  removeClientPayment,
  returnClientPaymentForCorrection,
  shipmentKeys,
  updateClientPayment,
  verifyClientPayment,
} from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { ReceiptField } from './receipt-field';

/**
 * What the client has paid for this trip, and what is still outstanding.
 *
 * THERE IS NO "AMOUNT PAID" FIELD TO EDIT, and its absence is the design — the
 * same one the allowances card makes. A trip is rarely settled in one movement:
 * a downpayment at booking, the balance a month after delivery. A second
 * payment is a second row, with its own date, method and check number, because
 * a single editable figure would swallow the first one whole.
 *
 * EVERY NUMBER HERE ARRIVES COMPUTED. `amountDue` is the same figure the gross
 * profit card calls revenue, and the balance is what somebody quotes to a
 * client down the phone — so both are derived once on the server rather than by
 * subtracting two strings in a browser.
 *
 * OFFICE-ONLY, decided by the page: a crew session is refused this route
 * outright, since what the company charges its client is not theirs to see.
 *
 * TWO DESKS SHARE THIS CARD, and the difference is what the buttons are. A
 * dispatch manager records payments and answers queries; accounting checks them
 * against the bank. Neither list is decided here — both mirror a role list on
 * the API, so a session shown a button it may not press would be a bug in one
 * place rather than a hole.
 */
export function PaymentsCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // Mirrors `CAN_RECORD_CLIENT_PAYMENT` and `CAN_VERIFY_CLIENT_PAYMENT`. The
  // second is deliberately narrower: the person who books a receipt is not the
  // person who confirms it against the bank.
  const canVerify = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;
  const canRecord = canVerify || user?.role === UserRole.DISPATCH_MANAGER;

  const summary = useQuery({
    queryKey: shipmentKeys.payments(shipment.id),
    queryFn: () => getClientPayments(shipment.id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const remove = useMutation({
    mutationFn: (id: string) => removeClientPayment(shipment.id, id),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not reverse that payment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const verify = useMutation({
    mutationFn: (id: string) => verifyClientPayment(id),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not verify that payment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const returnForCorrection = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      returnClientPaymentForCorrection(id, reason),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not return that payment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  /** The row whose correction form is open, if any. One at a time. */
  const [editing, setEditing] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: (input: RecordClientPaymentInput) => recordClientPayment(shipment.id, input),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not record that payment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: RecordClientPaymentInput }) =>
      updateClientPayment(shipment.id, id, input),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not save that correction', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const data = summary.data;
  const received = data?.payments ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payments received</CardTitle>
        <CardDescription>
          Money in from the client for this trip. Each payment is its own record — a downpayment and
          the balance are two lines, never an edit to the first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 border-b pb-3">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground text-sm">Billed</span>
            <span className="tabular-nums">{formatMoney(data?.amountDue ?? '0')}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground text-sm">Received</span>
            <span className="tabular-nums">{formatMoney(data?.amountPaid ?? '0')}</span>
          </div>
          {/* An unverified payment counts toward what has been received —
              money that arrived does not become less arrived while it waits for
              a tick — so what is worth saying separately is how much of it a
              second person has actually confirmed. */}
          {data && data.awaitingVerification > 0 ? (
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground text-sm">of which verified by accounting</span>
              <span className="text-muted-foreground tabular-nums">
                {formatMoney(data.amountVerified)}
              </span>
            </div>
          ) : null}
          {/* Returned money is excluded from "received", so it would simply
              vanish if it were not named. */}
          {data && data.amountReturned !== '0.00' ? (
            <div className="flex items-baseline justify-between">
              <span className="text-destructive text-sm">Returned, not counted</span>
              <span className="text-destructive tabular-nums">
                {formatMoney(data.amountReturned)}
              </span>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">Balance</span>
            <span className="flex items-center gap-2">
              {data ? <StatusBadge status={data.status} /> : null}
              <span className="text-lg font-semibold tabular-nums">
                {formatMoney(data?.balance ?? '0')}
              </span>
            </span>
          </div>
          {/* The breakdown of what was billed, so a disputed figure can be
              shown rather than asserted. */}
          {data ? (
            <p className="text-muted-foreground text-[11px]">
              {formatMoney(data.netRate)} freight
              {data.billableExpenses === '0.00'
                ? ''
                : ` · ${formatMoney(data.billableExpenses)} rebilled`}
              {data.additionalCharges === '0.00'
                ? ''
                : ` · ${formatMoney(data.additionalCharges)} charges`}
            </p>
          ) : null}
          {/* A late charge moves what is owed. Chasing a balance that can still
              grow is how a client ends up invoiced twice. */}
          {data?.amountDueIsProvisional ? (
            <p className="text-muted-foreground text-[11px]">
              Charges are still open on this trip, so what is owed can still change.
            </p>
          ) : null}
        </div>

        {summary.isPending ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : received.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing received yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {received.map((payment) => {
              // A verified payment is accounting's alone to change — the same
              // rule the service enforces, mirrored so nobody meets it as a
              // 409. Everything else is editable by whoever may record.
              const mayAlter =
                canRecord &&
                (canVerify || payment.verificationStatus !== PaymentVerificationStatus.VERIFIED);

              return (
                <li key={payment.id} className="space-y-2 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate">{formatDate(payment.receivedAt)}</p>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="outline">
                          {PAYMENT_METHOD_LABELS[payment.paymentMethod]}
                        </Badge>
                        {payment.referenceNumber ? (
                          <span>Ref {payment.referenceNumber}</span>
                        ) : null}
                        {/* The reference is on another live payment somewhere in
                            the system. Said, not refused: one check legitimately
                            settles two trips, and the person holding it is the one
                            who can tell that from the same slip entered twice. */}
                        {payment.referenceNumberIsDuplicated ? (
                          <span className="text-destructive inline-flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Reference already used on another payment
                          </span>
                        ) : null}
                        {payment.receiptId ? (
                          <a
                            className="underline underline-offset-4"
                            href={receiptContentUrl(payment.receiptId)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {payment.receiptFileName ?? 'Attachment'}
                          </a>
                        ) : null}
                      </div>
                      {payment.remarks ? (
                        <p className="text-muted-foreground text-xs">{payment.remarks}</p>
                      ) : null}
                      {/* What accounting has said about it. Never hidden from the
                          desk that recorded it — a return its author cannot see
                          is a return nobody answers. */}
                      <VerificationLine payment={payment} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums">{formatMoney(payment.amount)}</span>
                      {canVerify ? (
                        <VerifyControls
                          payment={payment}
                          pending={verify.isPending || returnForCorrection.isPending}
                          onVerify={() => verify.mutate(payment.id)}
                          onReturn={(reason) =>
                            returnForCorrection.mutate({ id: payment.id, reason })
                          }
                        />
                      ) : null}
                      {/* THE OTHER HALF OF "RETURN FOR CORRECTION". Without it
                          that decision is a dead end: accounting hands a payment
                          back saying the date is wrong and the person who
                          recorded it has nowhere to fix it, leaving delete-and-
                          retype as the only route — which throws away the
                          original row and everything recorded about it. */}
                      {mayAlter ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label="Edit payment"
                          onClick={() => setEditing(editing === payment.id ? null : payment.id)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      {mayAlter ? (
                        <ConfirmDeleteButton
                          label="Reverse payment"
                          title="Reverse this payment?"
                          description={`${formatMoney(payment.amount)} comes back off what this trip has collected, so the balance moves by the same amount. This is how a refund or a bounced check is recorded — who reversed it and when are kept beside the original amount and reference.`}
                          pending={remove.isPending}
                          onConfirm={() => remove.mutate(payment.id)}
                        />
                      ) : null}
                    </div>
                  </div>

                  {/* Inline, directly under the row, so the reason it was
                      returned stays on screen while it is being fixed. */}
                  {editing === payment.id && data ? (
                    <div className="bg-muted/40 rounded-md border p-3">
                      <PaymentForm
                        summary={data}
                        initial={payment}
                        excludeId={payment.id}
                        submitLabel="Save correction"
                        pending={update.isPending}
                        onCancel={() => setEditing(null)}
                        onSubmit={(input) => update.mutate({ id: payment.id, input })}
                      />
                      {/* Says what saving does to the verification state, which
                          is not obvious and is the whole point of the loop. */}
                      {canVerify ? null : (
                        <p className="text-muted-foreground mt-2 text-[11px]">
                          Saving sends this back to accounting to be checked again.
                        </p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {/* No status gate: terms of thirty or sixty days mean the last payment
            on a trip routinely arrives after it has closed, and a form that
            disappeared then would be a form that cannot record the settlement
            of anything. */}
        {canRecord && data ? (
          <div className="border-t pt-4">
            <PaymentForm
              summary={data}
              submitLabel="Record payment"
              pending={record.isPending}
              onSubmit={(input) => record.mutate(input)}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Where a payment stands with accounting, in a line under it.
 *
 * VERIFIED IS STATED QUIETLY and RETURNED loudly, which is the right way round:
 * a confirmed payment is the expected outcome and needs no attention, while a
 * returned one is somebody's next task and carries the sentence explaining what
 * to do about it.
 *
 * AN UNVERIFIED PAYMENT SAYS SO WITHOUT ALARM. It is the ordinary state of a
 * receipt somebody booked an hour ago, not a problem — and dressing it as one
 * teaches people to ignore the colour.
 */
function VerificationLine({ payment }: { payment: ClientPayment }) {
  if (payment.verificationStatus === PaymentVerificationStatus.RETURNED) {
    return (
      <p className="text-destructive flex items-start gap-1 text-xs">
        <MessageCircleQuestion className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          {PAYMENT_VERIFICATION_STATUS_LABELS[payment.verificationStatus]}
          {payment.verifiedByName ? ` (${payment.verifiedByName})` : ''}: {payment.verificationNote}
        </span>
      </p>
    );
  }

  if (payment.verificationStatus === PaymentVerificationStatus.VERIFIED) {
    return (
      <p className="text-muted-foreground flex items-center gap-1 text-xs">
        <BadgeCheck className="h-3 w-3" />
        Verified{payment.verifiedByName ? ` by ${payment.verifiedByName}` : ''}
      </p>
    );
  }

  return (
    <p className="text-muted-foreground text-xs">
      {PAYMENT_VERIFICATION_STATUS_LABELS[payment.verificationStatus]}
      {payment.recordedByName ? ` · recorded by ${payment.recordedByName}` : ''}
    </p>
  );
}

/**
 * Accounting's two answers.
 *
 * RETURNING ASKS FOR ITS REASON BEFORE IT WILL SEND, because the reason is the
 * entire content of the message going back — a refusal with nothing to act on
 * is whoever recorded it being told to look again with no idea what to look
 * for. The API and a CHECK both refuse a blank one; this is what stops somebody
 * meeting that rule as an error.
 *
 * THERE IS NO "VERIFY AGAIN" ON AN ALREADY VERIFIED ROW, and its absence is
 * deliberate. There is no history table here, so a second stamp would not
 * record that two people looked — it would overwrite the name and date of the
 * one who did, permanently and with nothing saying so. The API refuses it as
 * well; hiding the button is the courtesy that stops somebody meeting that rule
 * as a 409. Accounting who thinks an earlier check was wrong returns the
 * payment for correction, which is recorded.
 */
function VerifyControls({
  payment,
  pending,
  onVerify,
  onReturn,
}: {
  payment: ClientPayment;
  pending: boolean;
  onVerify: () => void;
  onReturn: (reason: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  const verified = payment.verificationStatus === PaymentVerificationStatus.VERIFIED;

  if (asking) {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          className="h-8 w-52"
          placeholder="What does not match?"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending || reason.trim().length === 0}
          onClick={() => {
            onReturn(reason.trim());
            setReason('');
            setAsking(false);
          }}
        >
          Return
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {/* Absent once verified: a second stamp would overwrite the first
          verifier's name and date, and nothing would record that it had. */}
      {verified ? null : (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onVerify}>
          {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          Mark as verified
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setAsking(true)}
      >
        Return for correction
      </Button>
    </div>
  );
}

/**
 * Overpaid is the one that has to stand out — it means the company owes money
 * back, which is somebody's job to sort out rather than a state to note.
 */
function StatusBadge({ status }: { status: PaymentStatus }) {
  const variant =
    status === 'PAID' ? 'default' : status === 'OVERPAID' ? 'destructive' : 'secondary';

  return <Badge variant={variant}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

/**
 * The one payment form, used to record a new payment and to correct an existing
 * one.
 *
 * ONE COMPONENT FOR BOTH, deliberately. The fields, the reference warning and
 * the date handling are identical, and a second form would be a second place
 * for the "date-only input means midnight local" conversion to be got subtly
 * wrong. What differs is the initial values, the submit label and which
 * mutation runs — so those are the props.
 */
function PaymentForm({
  summary,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  excludeId,
}: {
  summary: ClientPaymentSummary;
  initial?: ClientPayment;
  submitLabel: string;
  pending: boolean;
  onSubmit: (input: RecordClientPaymentInput) => void;
  onCancel?: () => void;
  /** The payment being edited, so its own reference is not read as a clash. */
  excludeId?: string;
}) {
  const [draft, setDraft] = useState({
    /**
     * DELIBERATELY BLANK ON A NEW PAYMENT, unlike the allowance form's prefilled
     * standard figure. The amount is being read off a check or a bank
     * confirmation, and a field pre-filled with the outstanding balance is one
     * somebody submits without looking — recording the balance they were owed
     * rather than the payment they were sent. The balance is shown just above.
     *
     * On a correction it is the recorded amount, because that IS what is being
     * corrected and retyping it from scratch invites a second mistake.
     */
    amount: initial ? initial.amount : '',
    // Today on a new one, and editable: a check that cleared on Friday is
    // routinely typed up on Monday, and a payment dated the day it was recorded
    // misstates when the trip was actually settled. On a correction, the stored
    // date read in Manila — see `toDateInputValue` for why slicing the ISO
    // string would put yesterday in the field.
    receivedAt: initial
      ? toDateInputValue(initial.receivedAt)
      : new Date().toISOString().slice(0, 10),
    paymentMethod: String(initial ? initial.paymentMethod : PaymentMethod.BANK_TRANSFER),
    referenceNumber: initial?.referenceNumber ?? '',
    receiptId: initial?.receiptId ?? (null as string | null),
    receiptFileName: initial?.receiptFileName ?? (null as string | null),
    remarks: initial?.remarks ?? '',
  });

  const method = Number(draft.paymentMethod) as PaymentMethod;

  // Case-insensitive and trimmed, because "BPI-4417" and "bpi-4417 " are the
  // same check typed by two people. Compared against what the summary already
  // holds, so it costs no request — and skipping the row being edited, or a
  // correction that left the reference alone would warn about itself.
  const typedReference = draft.referenceNumber.trim().toLowerCase();
  const alreadyOnThisTrip =
    typedReference.length > 0 &&
    summary.payments.some(
      (payment) =>
        payment.id !== excludeId &&
        (payment.referenceNumber ?? '').trim().toLowerCase() === typedReference,
    );

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          amount: draft.amount,
          // A date-only input means midnight local; sent as an instant, because
          // storage is UTC and the display layer renders Asia/Manila.
          receivedAt: new Date(draft.receivedAt).toISOString(),
          paymentMethod: method,
          referenceNumber: draft.referenceNumber || null,
          receiptId: draft.receiptId,
          remarks: draft.remarks || null,
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="payment-amount" className="text-xs">
            Amount
          </Label>
          <Input
            id="payment-amount"
            placeholder="0.00"
            inputMode="decimal"
            required
            value={draft.amount}
            onChange={(event) =>
              setDraft((current) => ({ ...current, amount: event.target.value }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="payment-received-at" className="text-xs">
            Received on
          </Label>
          <Input
            id="payment-received-at"
            type="date"
            required
            value={draft.receivedAt}
            onChange={(event) =>
              setDraft((current) => ({ ...current, receivedAt: event.target.value }))
            }
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="payment-method" className="text-xs">
          Received by
        </Label>
        <Select
          value={draft.paymentMethod}
          onValueChange={(value) => setDraft((current) => ({ ...current, paymentMethod: value }))}
        >
          <SelectTrigger id="payment-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.values(PaymentMethod).map((value) => (
              <SelectItem key={value} value={String(value)}>
                {PAYMENT_METHOD_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="payment-reference" className="text-xs">
          Reference
        </Label>
        <Input
          id="payment-reference"
          // Never required, whatever the method: cash collected at the client's
          // office has none, and a mandatory field is answered with "N/A".
          placeholder={
            method === PaymentMethod.CHECK
              ? 'Check number'
              : expectsPaymentReference(method)
                ? 'Transaction reference'
                : 'Optional'
          }
          value={draft.referenceNumber}
          onChange={(event) =>
            setDraft((current) => ({ ...current, referenceNumber: event.target.value }))
          }
        />
        {/* Checked against this trip's payments as it is typed — the case the
            person can still fix without saving anything. Payments on OTHER
            trips are caught too, but only by the server, which is what the
            warning on the rows above reports. */}
        {alreadyOnThisTrip ? (
          <p className="text-destructive flex items-center gap-1 text-[11px]">
            <AlertTriangle className="h-3 w-3" />A payment on this trip already carries that
            reference. Save it anyway if one check covered both.
          </p>
        ) : null}
      </div>

      <Input
        placeholder="Remarks (optional)"
        value={draft.remarks}
        onChange={(event) => setDraft((current) => ({ ...current, remarks: event.target.value }))}
      />

      <ReceiptField
        value={draft.receiptId}
        fileName={draft.receiptFileName}
        label="Attach proof"
        onChange={(receiptId, fileName) =>
          setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
        }
      />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
