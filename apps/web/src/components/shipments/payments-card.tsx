'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PaymentMethod,
  UserRole,
  expectsPaymentReference,
  type ClientPaymentSummary,
  type PaymentStatus,
  type Shipment,
} from '@eztruckr/types';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import { formatDate, formatMoney } from '@/lib/format';
import {
  getClientPayments,
  recordClientPayment,
  removeClientPayment,
  shipmentKeys,
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
 */
export function PaymentsCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const canRecord = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

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
            {received.map((payment) => (
              <li key={payment.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0 space-y-1">
                  <p className="truncate">{formatDate(payment.receivedAt)}</p>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</Badge>
                    {payment.referenceNumber ? <span>Ref {payment.referenceNumber}</span> : null}
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
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatMoney(payment.amount)}</span>
                  {canRecord ? (
                    <ConfirmDeleteButton
                      label="Reverse payment"
                      title="Reverse this payment?"
                      description={`${formatMoney(payment.amount)} comes back off what this trip has collected, so the balance moves by the same amount. This is how a refund or a bounced check is recorded — who reversed it and when are kept beside the original amount and reference.`}
                      pending={remove.isPending}
                      onConfirm={() => remove.mutate(payment.id)}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* No status gate: terms of thirty or sixty days mean the last payment
            on a trip routinely arrives after it has closed, and a form that
            disappeared then would be a form that cannot record the settlement
            of anything. */}
        {canRecord && data ? (
          <RecordForm shipment={shipment} summary={data} onSaved={invalidate} />
        ) : null}
      </CardContent>
    </Card>
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

function RecordForm({
  shipment,
  summary,
  onSaved,
}: {
  shipment: Shipment;
  summary: ClientPaymentSummary;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({
    /**
     * DELIBERATELY BLANK, unlike the allowance form's prefilled standard
     * figure. The amount is being read off a check or a bank confirmation, and
     * a field pre-filled with the outstanding balance is one somebody submits
     * without looking — recording the balance they were owed rather than the
     * payment they were sent. The balance is shown two inches above it.
     */
    amount: '',
    // Today, and editable: a check that cleared on Friday is routinely typed
    // up on Monday, and a payment dated the day it was recorded misstates when
    // the trip was actually settled.
    receivedAt: new Date().toISOString().slice(0, 10),
    paymentMethod: String(PaymentMethod.BANK_TRANSFER),
    referenceNumber: '',
    receiptId: null as string | null,
    receiptFileName: null as string | null,
    remarks: '',
  });

  const record = useMutation({
    mutationFn: () =>
      recordClientPayment(shipment.id, {
        amount: draft.amount,
        // A date-only input means midnight local; sent as an instant, because
        // storage is UTC and the display layer renders Asia/Manila.
        receivedAt: new Date(draft.receivedAt).toISOString(),
        paymentMethod: Number(draft.paymentMethod) as PaymentMethod,
        referenceNumber: draft.referenceNumber || null,
        receiptId: draft.receiptId,
        remarks: draft.remarks || null,
      }),
    onSuccess: () => {
      setDraft((current) => ({
        ...current,
        amount: '',
        referenceNumber: '',
        receiptId: null,
        receiptFileName: null,
        remarks: '',
      }));
      onSaved();
    },
    onError: (error: unknown) =>
      toast.error('Could not record that payment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const method = Number(draft.paymentMethod) as PaymentMethod;

  // Case-insensitive and trimmed, because "BPI-4417" and "bpi-4417 " are the
  // same check typed by two people. Compared against what the summary already
  // holds, so it costs no request.
  const typedReference = draft.referenceNumber.trim().toLowerCase();
  const alreadyOnThisTrip =
    typedReference.length > 0 &&
    summary.payments.some(
      (payment) => (payment.referenceNumber ?? '').trim().toLowerCase() === typedReference,
    );

  return (
    <form
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        record.mutate();
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
            reference. Record it anyway if one check covered both.
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

      <Button type="submit" size="sm" disabled={record.isPending}>
        {record.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Record payment
      </Button>
    </form>
  );
}
