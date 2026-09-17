'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_METHOD_LABELS,
  PaymentMethod,
  PaymentVerificationStatus,
  SHIPMENT_STATUS_LABELS,
  UserRole,
  expectsPaymentReference,
  formatRate,
  isRateChainCorrectable,
  type Page,
  type Shipment,
  type ThirdParty,
} from '@eztruckr/types';
import { BadgeCheck, CircleCheck, Loader2, MessageCircleQuestion, Pencil } from 'lucide-react';
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
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatMoney, toDateInputValue } from '@/lib/format';
import {
  markThirdPartyCommissionPaid,
  returnThirdPartyCommissionPayment,
  shipmentKeys,
  unmarkThirdPartyCommissionPaid,
  updateRateChain,
  verifyThirdPartyCommissionPayment,
} from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * The rate chain and the commission chain, shown as arithmetic.
 *
 * Every figure here is read from the shipment exactly as the API stored it —
 * nothing on this screen is derived in the browser. The layout deliberately
 * reads like a worksheet, one operation per line, because the promise the
 * backend makes is that a reviewer can reproduce each line from the one above
 * it with a calculator. A summary card that only showed the totals would hide
 * precisely the thing that makes the figures checkable.
 */

function Row({
  label,
  value,
  operator,
  note,
  emphasis,
}: {
  label: string;
  value: string | null;
  operator?: '−' | '+' | '×' | '=';
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1.5 ${
        emphasis ? 'border-t font-medium' : ''
      }`}
    >
      <div className="min-w-0">
        <span className="text-muted-foreground mr-2 inline-block w-4 text-right tabular-nums">
          {operator ?? ''}
        </span>
        <span className={emphasis ? '' : 'text-muted-foreground'}>{label}</span>
        {note ? <span className="text-muted-foreground ml-2 text-xs">{note}</span> : null}
      </div>
      <span className="shrink-0 tabular-nums">{value === null ? '—' : formatMoney(value)}</span>
    </div>
  );
}

export function RateChainCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const [correcting, setCorrecting] = useState(false);
  const computed = shipment.commissionsComputedAt !== null;

  /**
   * Mirrors `CAN_EDIT_RATE_CHAIN` and `isRateChainCorrectable` on the API.
   *
   * The status half is honest here; the harder half is not, and cannot be —
   * a correction is refused once any commission has been PAID, which this
   * screen does not know. So the button is offered and the refusal arrives as
   * a message naming how many commissions were paid, which is more use than a
   * silently missing button would be.
   */
  // Mirror `CAN_VERIFY_THIRD_PARTY_PAYMENT` and `CAN_RECORD_THIRD_PARTY_PAYMENT`:
  // the dispatch manager records, accounting approves.
  const mayVerifyCutPayment =
    user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;
  const mayRecordCutPayment = mayVerifyCutPayment || user?.role === UserRole.DISPATCH_MANAGER;

  const mayCorrect =
    (user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING) &&
    isRateChainCorrectable(shipment.status);

  /**
   * NOTHING here is for a crew session — not the rate chain, and not the
   * commission base either.
   *
   * This card briefly showed crew the base alone. That was narrowed again by
   * explicit decision: a crew member sees what they earned, on the commissions
   * card, and none of the figures it was computed from. The API nulls every one
   * of them (`redactRevenueForCrew`), so rendering anything here would be a
   * column of "—" that still announces the figures exist and are withheld.
   *
   * Returning null rather than being omitted by the page keeps the rule with
   * the card that would otherwise leak it — a caller who adds this component to
   * a new screen cannot forget the check.
   */
  if (user?.role === UserRole.CREW) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle>Rate chain</CardTitle>
            <CardDescription>
              Gross freight less the broker cut gives the net rate. Every figure is computed and
              stored by the server.
            </CardDescription>
          </div>
          {mayCorrect && !correcting ? (
            <Button size="sm" variant="outline" onClick={() => setCorrecting(true)}>
              <Pencil className="size-4" />
              Correct
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        <Row label="Gross rate" value={shipment.grossRate} />
        <Row
          label="Third-party commission"
          value={shipment.tpcAmount}
          operator="−"
          note={
            shipment.appliedTpcRate
              ? `${formatRate(shipment.appliedTpcRate)} of gross`
              : shipment.thirdPartyId
                ? 'flat amount agreed'
                : 'direct client'
          }
        />
        <Row label="Net rate" value={shipment.netRate} operator="=" emphasis />

        <ThirdPartyPayment
          shipment={shipment}
          mayRecord={mayRecordCutPayment}
          mayVerify={mayVerifyCutPayment}
        />

        {correcting ? (
          <CorrectionForm shipment={shipment} onClose={() => setCorrecting(false)} />
        ) : null}

        <div className="mt-6">
          <h4 className="mb-1 font-medium">Commission base</h4>
          {!computed ? (
            <p className="text-muted-foreground py-2 text-xs">
              Not computed yet. The base is derived when commissions are computed, and frozen at
              that moment — {SHIPMENT_STATUS_LABELS[shipment.status].toLowerCase()} shipments show
              it once that has happened.
            </p>
          ) : (
            <>
              <Row label="Net rate" value={shipment.netRate} />
              <Row
                label="Commissionable charges"
                value={shipment.commissionableCharges}
                operator="+"
                note="only lines flagged commissionable"
              />
              <Row label="Gross for commission" value={shipment.grossForCommission} operator="=" />
              <Row
                label="Gas expense deduction"
                value={shipment.gasDeductionAmount}
                operator="−"
                // The rate this computation used, stated plainly and nothing
                // more. It deliberately does NOT say whether that rate came
                // from an override: `gasRateOverrideReason` describes the
                // override in force *now*, which may have been set after this
                // computation ran, so annotating from it would be a claim this
                // card cannot substantiate. The gas card below owns that
                // distinction, and shows the frozen and effective rates side
                // by side when they differ.
                note={
                  shipment.appliedGasDeductionRate
                    ? formatRate(shipment.appliedGasDeductionRate)
                    : undefined
                }
              />
              <Row
                label="Commissionable base"
                value={shipment.commissionableBase}
                operator="="
                emphasis
              />
              <p className="text-muted-foreground mt-3 text-xs">
                The gas deduction reduces the commission base only. It is not a cost line — actual
                fuel is recognised through the liquidation, and counting it here as well would
                double it.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Whether the broker has been paid their cut, and how.
 *
 * The cut stays in what the client is billed either way. Marking it paid takes
 * it off the client's balance on the payments card — the API does that
 * subtraction, not this screen.
 */
function ThirdPartyPayment({
  shipment,
  mayRecord,
  mayVerify,
}: {
  shipment: Shipment;
  mayRecord: boolean;
  mayVerify: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  const onError = (title: string) => (error: unknown) =>
    toast.error(title, {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const unmark = useMutation({
    mutationFn: () => unmarkThirdPartyCommissionPaid(shipment.id),
    onSuccess: invalidate,
    onError: onError('Could not unmark the payment'),
  });

  const verify = useMutation({
    mutationFn: () => verifyThirdPartyCommissionPayment(shipment.id),
    onSuccess: invalidate,
    onError: onError('Could not approve the payment'),
  });

  const sendBack = useMutation({
    mutationFn: (reason: string) => returnThirdPartyCommissionPayment(shipment.id, reason),
    onSuccess: invalidate,
    onError: onError('Could not return the payment'),
  });

  // Nothing to pay on a direct booking or a zero cut. A presence check on the
  // server's own figure, not arithmetic.
  if (shipment.thirdPartyId === null || shipment.tpcAmount === null) return null;
  if (Number(shipment.tpcAmount) === 0) return null;

  const paid = shipment.tpcPaidAt !== null;
  const status = shipment.tpcVerificationStatus;
  // A verified payment is accounting's to change, as on a client payment.
  const mayAlter = mayRecord && (mayVerify || status !== PaymentVerificationStatus.VERIFIED);

  return (
    <div className="mt-3 space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">Payment to {shipment.thirdPartyName ?? 'third party'}</span>
          {!paid ? (
            <Badge variant="outline">Unpaid</Badge>
          ) : status === PaymentVerificationStatus.VERIFIED ? (
            <Badge variant="secondary" className="gap-1">
              <CircleCheck className="size-3" />
              Paid · verified
            </Badge>
          ) : status === PaymentVerificationStatus.RETURNED ? (
            <Badge variant="destructive">Returned</Badge>
          ) : (
            <Badge variant="outline">Paid · awaiting accounting</Badge>
          )}
        </div>
        {mayAlter && !editing ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {paid ? <Pencil className="size-4" /> : null}
              {paid ? 'Edit' : 'Mark as paid'}
            </Button>
            {paid ? (
              <ConfirmDeleteButton
                label="Unmark third-party payment"
                title="Mark the cut as unpaid?"
                description="The payment details are cleared and the cut is added back to the client's balance."
                confirmLabel="Unmark"
                pending={unmark.isPending}
                onConfirm={() => unmark.mutate()}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {paid && !editing ? (
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
          <dt>Paid on</dt>
          <dd>{formatDate(shipment.tpcPaidAt!)}</dd>
          <dt>Paid by</dt>
          <dd>
            {shipment.tpcPaymentMethod === null
              ? '—'
              : PAYMENT_METHOD_LABELS[shipment.tpcPaymentMethod]}
          </dd>
          <dt>Reference</dt>
          <dd>{shipment.tpcReferenceNumber ?? '—'}</dd>
          <dt>Remarks</dt>
          <dd className="whitespace-pre-wrap">{shipment.tpcPaymentRemarks ?? '—'}</dd>
        </dl>
      ) : null}

      {paid && !editing ? <CutVerificationLine shipment={shipment} /> : null}

      {paid && !editing && mayVerify ? (
        <CutVerifyControls
          verified={status === PaymentVerificationStatus.VERIFIED}
          pending={verify.isPending || sendBack.isPending}
          onVerify={() => verify.mutate()}
          onReturn={(reason) => sendBack.mutate(reason)}
        />
      ) : null}

      {!paid && !editing ? (
        <p className="text-muted-foreground text-xs">
          Once marked paid, the cut of {formatMoney(shipment.tpcAmount)} is deducted from the
          client&rsquo;s balance.
        </p>
      ) : null}

      {editing ? (
        <ThirdPartyPaymentForm
          shipment={shipment}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            invalidate();
          }}
          onError={onError('Could not save the payment')}
        />
      ) : null}
    </div>
  );
}

/**
 * Who checked the payment, or why it came back. A returned one carries the
 * reason, because that is the whole of what the recorder has to act on.
 */
function CutVerificationLine({ shipment }: { shipment: Shipment }) {
  const by = shipment.tpcVerifiedByName;

  if (shipment.tpcVerificationStatus === PaymentVerificationStatus.RETURNED) {
    return (
      <p className="text-destructive flex items-start gap-1 text-xs">
        <MessageCircleQuestion className="mt-0.5 size-3 shrink-0" />
        <span>
          Returned for correction{by ? ` by ${by}` : ''}: {shipment.tpcVerificationNote}
        </span>
      </p>
    );
  }

  if (shipment.tpcVerificationStatus === PaymentVerificationStatus.VERIFIED) {
    return (
      <p className="text-muted-foreground flex items-center gap-1 text-xs">
        <BadgeCheck className="size-3" />
        Verified{by ? ` by ${by}` : ''}
        {shipment.tpcVerifiedAt ? ` on ${formatDate(shipment.tpcVerifiedAt)}` : ''}
      </p>
    );
  }

  return <p className="text-muted-foreground text-xs">Waiting for accounting to verify it.</p>;
}

/**
 * Accounting's two answers. Returning asks for its reason before it will send;
 * there is no second approval of an approved payment, which would overwrite the
 * first checker's name.
 */
function CutVerifyControls({
  verified,
  pending,
  onVerify,
  onReturn,
}: {
  verified: boolean;
  pending: boolean;
  onVerify: () => void;
  onReturn: (reason: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  if (asking) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Input
          autoFocus
          className="h-8 w-60"
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
    <div className="flex flex-wrap items-center gap-1">
      {verified ? null : (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onVerify}>
          {pending ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
          Approve
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

function ThirdPartyPaymentForm({
  shipment,
  onClose,
  onSaved,
  onError,
}: {
  shipment: Shipment;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState({
    // Today on a first marking; the stored date, read in Manila, on an edit.
    paidAt: shipment.tpcPaidAt
      ? toDateInputValue(shipment.tpcPaidAt)
      : new Date().toISOString().slice(0, 10),
    paymentMethod: String(shipment.tpcPaymentMethod ?? PaymentMethod.BANK_TRANSFER),
    referenceNumber: shipment.tpcReferenceNumber ?? '',
    remarks: shipment.tpcPaymentRemarks ?? '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const method = Number(draft.paymentMethod) as PaymentMethod;

  const save = useMutation({
    mutationFn: () =>
      markThirdPartyCommissionPaid(shipment.id, {
        // A date-only input means midnight local; sent as an instant.
        paidAt: new Date(draft.paidAt).toISOString(),
        paymentMethod: method,
        referenceNumber: draft.referenceNumber || null,
        remarks: draft.remarks || null,
      }),
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      onError(error);
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setFieldErrors({});
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Paid on" htmlFor="tpc-paid-at" error={fieldErrors.paidAt}>
          <Input
            id="tpc-paid-at"
            type="date"
            required
            value={draft.paidAt}
            onChange={(event) =>
              setDraft((current) => ({ ...current, paidAt: event.target.value }))
            }
          />
        </Field>
        <Field label="Mode of payment" htmlFor="tpc-method" error={fieldErrors.paymentMethod}>
          <Select
            value={draft.paymentMethod}
            onValueChange={(value) => setDraft((current) => ({ ...current, paymentMethod: value }))}
          >
            <SelectTrigger id="tpc-method">
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
        </Field>
      </div>

      <Field label="Reference" htmlFor="tpc-reference" error={fieldErrors.referenceNumber}>
        <Input
          id="tpc-reference"
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
      </Field>

      <Field label="Remarks" htmlFor="tpc-remarks" error={fieldErrors.remarks}>
        <Input
          id="tpc-remarks"
          placeholder="Optional"
          value={draft.remarks}
          onChange={(event) => setDraft((current) => ({ ...current, remarks: event.target.value }))}
        />
      </Field>

      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          {shipment.tpcPaidAt ? 'Save changes' : 'Mark as paid'}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const DIRECT = '__direct__';

type CutBasis = 'rate' | 'amount' | 'none';

/**
 * Correcting an agreed figure, after the trip has left DRAFT.
 *
 * THE WHOLE CHAIN IS RESTATED, not the one field being fixed. A cut belongs to
 * the broker it was agreed with and is held as EITHER a percentage or a flat
 * peso figure — which of the two is what `appliedTpcRate` records — so a form
 * that sent only the field somebody touched would leave the API guessing at the
 * rest. Sending all four fields makes the request say exactly what the deal now
 * is, and the server re-derives the net from it.
 *
 * No arithmetic here, as everywhere else under `src/`: the corrected net rate
 * arrives back from the API in the response this invalidates.
 */
function CorrectionForm({ shipment, onClose }: { shipment: Shipment; onClose: () => void }) {
  const queryClient = useQueryClient();

  const [grossRate, setGrossRate] = useState(shipment.grossRate ?? '');
  const [thirdPartyId, setThirdPartyId] = useState(shipment.thirdPartyId ?? DIRECT);
  const [basis, setBasis] = useState<CutBasis>(
    shipment.appliedTpcRate ? 'rate' : shipment.thirdPartyId ? 'amount' : 'none',
  );
  const [tpcRate, setTpcRate] = useState(shipment.appliedTpcRate ?? '');
  const [tpcAmount, setTpcAmount] = useState(shipment.tpcAmount ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // A cut needs somebody to owe it to; the API refuses the pair outright, so
  // the form follows the broker rather than letting the two disagree on screen.
  useEffect(() => {
    if (thirdPartyId === DIRECT) setBasis('none');
  }, [thirdPartyId]);

  const brokers = useQuery({
    queryKey: ['third-parties', 'for-rate-chain'],
    queryFn: () => apiFetch<Page<ThirdParty>>('/third-parties?pageSize=200'),
  });

  const save = useMutation({
    mutationFn: () =>
      updateRateChain(shipment.id, {
        grossRate,
        thirdPartyId: thirdPartyId === DIRECT ? null : thirdPartyId,
        tpcRate: basis === 'rate' ? tpcRate : null,
        tpcAmount: basis === 'amount' ? tpcAmount : null,
      }),
    onSuccess: () => {
      toast.success('Rate chain corrected', {
        description:
          'Any commissions already computed now report themselves stale — recompute them from the commissions card.',
      });
      onClose();
      void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        toast.error('That correction was refused', { description: error.displayMessage });
        return;
      }
      toast.error('Something went wrong');
    },
  });

  return (
    <form
      className="mt-4 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setFieldErrors({});
        save.mutate();
      }}
    >
      <p className="text-muted-foreground text-xs">
        For a figure that was agreed and recorded wrong. It moves the commission base for everyone
        on this trip, so it is refused once any commission here has been paid.
      </p>

      <Field label="Gross rate" htmlFor="grossRate" error={fieldErrors.grossRate}>
        <Input
          id="grossRate"
          inputMode="decimal"
          value={grossRate}
          onChange={(event) => setGrossRate(event.target.value)}
          placeholder="125000.00"
        />
      </Field>

      <Field label="Third party" htmlFor="thirdPartyId" error={fieldErrors.thirdPartyId}>
        <Select value={thirdPartyId} onValueChange={setThirdPartyId}>
          <SelectTrigger id="thirdPartyId">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DIRECT}>Direct client — no broker cut</SelectItem>
            {(brokers.data?.items ?? []).map((broker) => (
              <SelectItem key={broker.id} value={broker.id}>
                {broker.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {thirdPartyId === DIRECT ? null : (
        <Field label="Cut agreed as" htmlFor="basis">
          <Select value={basis} onValueChange={(value) => setBasis(value as CutBasis)}>
            <SelectTrigger id="basis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rate">A percentage of gross</SelectItem>
              <SelectItem value="amount">A flat amount</SelectItem>
              <SelectItem value="none">Nothing — no cut on this trip</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      {thirdPartyId !== DIRECT && basis === 'rate' ? (
        <Field label="Rate" htmlFor="tpcRate" error={fieldErrors.tpcRate}>
          <Input
            id="tpcRate"
            inputMode="decimal"
            value={tpcRate}
            onChange={(event) => setTpcRate(event.target.value)}
            placeholder="0.1000"
          />
          <p className="text-muted-foreground text-xs">
            A multiplier between 0 and 1 — 0.1000 is 10%.
          </p>
        </Field>
      ) : null}

      {thirdPartyId !== DIRECT && basis === 'amount' ? (
        <Field label="Flat amount" htmlFor="tpcAmount" error={fieldErrors.tpcAmount}>
          <Input
            id="tpcAmount"
            inputMode="decimal"
            value={tpcAmount}
            onChange={(event) => setTpcAmount(event.target.value)}
            placeholder="5000.00"
          />
        </Field>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Save correction
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
