'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISBURSEMENT_MODE_LABELS,
  DisbursementMode,
  LiquidationStatus,
  UserRole,
  expectsReferenceNumber,
  liquidationAccountLabel,
  type AllowanceSummary,
  type Liquidation,
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
import { ApiError } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import {
  getAllowances,
  issueAllowance,
  liquidationKeys,
  listShipmentLiquidations,
  receiptContentUrl,
  removeAllowance,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { useTripCashHolders } from './trip-cash-holders';
import { ReceiptField } from './receipt-field';

/**
 * Every release of cash on this trip, and the total they add up to.
 *
 * THERE IS NO "EDIT THE ALLOWANCE" BUTTON, and its absence is the design. A
 * trip carries an initial advance and whatever the road demands afterwards, so
 * a second release is a second row — with its own date, its own mode and its
 * own paper trail. A single editable figure would swallow the first one whole.
 *
 * EVERY RELEASE NAMES TWO PEOPLE, and they are not the same question. Who
 * RECEIVED the cash is the crew member it was handed to; which ACCOUNT it is
 * booked against is whose variance it moves. A helper can be given ferry money
 * the driver answers for, so the form asks both.
 *
 * `totalAdvanced` comes from the API rather than being summed here. It is the
 * figure the variance is measured against, and a number a crew member may be
 * asked to hand cash back against should be computed once, on the server.
 */
export function AllowancesCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const canIssueRole = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const summary = useQuery({
    queryKey: liquidationKeys.allowances(shipment.id),
    queryFn: () => getAllowances(shipment.id),
  });

  // The accounts a release can be booked against. Shares a cache key with the
  // liquidation card, so showing both costs one request rather than two.
  const accounts = useQuery({
    queryKey: liquidationKeys.liquidations(shipment.id),
    queryFn: () => listShipmentLiquidations(shipment.id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: liquidationKeys.all });
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const remove = useMutation({
    mutationFn: (id: string) => removeAllowance(shipment.id, id),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not remove that release', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const data = summary.data;
  const releases = data?.allowances ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Allowances</CardTitle>
        <CardDescription>
          Cash released to the crew for this trip. Each release is its own record — a top-up called
          in from the road is a new line, never an edit to the first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between border-b pb-3">
          <span className="text-muted-foreground text-sm">Total advanced</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatMoney(data?.totalAdvanced ?? '0')}
          </span>
        </div>

        {summary.isPending ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : releases.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing released yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {releases.map((release) => (
              <li key={release.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0 space-y-1">
                  <p className="truncate">
                    {release.staffName ?? 'Crew'} · {formatDate(release.issuedAt)}
                  </p>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline">
                      {DISBURSEMENT_MODE_LABELS[release.disbursementMode]}
                    </Badge>
                    {/* Whose variance this moves, which is not necessarily the
                        person it was handed to. */}
                    <span>
                      on{' '}
                      {liquidationAccountLabel(release.custodianName, release.liquidationSequence)}
                    </span>
                    {release.referenceNumber ? <span>Ref {release.referenceNumber}</span> : null}
                    {/* The reference is on another live release somewhere in
                        the system. Said, not refused: one transfer covering two
                        crew members legitimately shares a reference, and the
                        person holding the slip is the one who can tell that
                        from the same slip entered twice. */}
                    {release.referenceNumberIsDuplicated ? (
                      <span className="text-destructive inline-flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Reference already used on another release
                      </span>
                    ) : null}
                    {release.releasedByName ? <span>by {release.releasedByName}</span> : null}
                    {release.receiptId ? (
                      <a
                        className="underline underline-offset-4"
                        href={receiptContentUrl(release.receiptId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {release.receiptFileName ?? 'Attachment'}
                      </a>
                    ) : null}
                  </div>
                  {release.remarks ? (
                    <p className="text-muted-foreground text-xs">{release.remarks}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatMoney(release.amount)}</span>
                  {canIssueRole && data?.canIssue ? (
                    <ConfirmDeleteButton
                      label="Remove release"
                      title="Remove this cash release?"
                      description={`${formatMoney(release.amount)} comes off ${liquidationAccountLabel(
                        release.custodianName,
                        release.liquidationSequence,
                      )}, so its variance moves by the same amount. Records a release that never happened as never having happened — correct one that did by removing it and recording it again.`}
                      pending={remove.isPending}
                      onConfirm={() => remove.mutate(release.id)}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canIssueRole ? (
          data?.canIssue ? (
            <IssueForm
              shipment={shipment}
              summary={data}
              accounts={accounts.data ?? []}
              onIssued={invalidate}
            />
          ) : (
            <p className="text-muted-foreground border-t pt-4 text-xs">
              No account on this trip can take a release — every liquidation is approved, or the
              trip is closed. Reverse an approval, with a reason, to record another.
            </p>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function IssueForm({
  shipment,
  summary,
  accounts,
  onIssued,
}: {
  shipment: Shipment;
  summary: AllowanceSummary;
  accounts: Liquidation[];
  onIssued: () => void;
}) {
  const crew = useTripCashHolders(shipment);

  // Only the accounts that would accept it. An approved account has its total
  // advanced frozen, and offering it here would put the refusal after the
  // typing rather than before it.
  const open = accounts.filter((account) => account.status !== LiquidationStatus.APPROVED);

  // The route's standard allowance prefills the FIRST release only. A top-up is
  // whatever the road actually cost, and offering the standard figure again
  // would be suggesting a number nobody meant.
  const [draft, setDraft] = useState({
    /** Empty until chosen; the default is resolved below, not frozen here. */
    liquidationId: '',
    staffId: crew[0]?.id ?? '',
    amount: summary.releaseCount === 0 ? (summary.routeStandardAllowance ?? '') : '',
    // Today, and editable: cash handed over on Friday is routinely typed up on
    // Monday, and a release dated the day it was recorded misstates when the
    // crew actually had the money.
    issuedAt: new Date().toISOString().slice(0, 10),
    disbursementMode: String(DisbursementMode.CASH),
    referenceNumber: '',
    receiptId: null as string | null,
    receiptFileName: null as string | null,
    remarks: '',
  });

  // The trip's own account leads the list, so it is what a release lands on
  // when nobody has chosen otherwise — the common case by far. Resolved on
  // every render rather than seeded into `useState`, because the accounts
  // arrive after this form first mounts and a state seeded from an empty list
  // stays empty once it fills.
  const liquidationId = draft.liquidationId || (open[0]?.id ?? '');

  const issue = useMutation({
    mutationFn: () =>
      issueAllowance(shipment.id, {
        liquidationId,
        staffId: draft.staffId,
        amount: draft.amount,
        // A date-only input means midnight local; sent as an instant, because
        // storage is UTC and the display layer renders Asia/Manila.
        issuedAt: new Date(draft.issuedAt).toISOString(),
        disbursementMode: Number(draft.disbursementMode) as DisbursementMode,
        referenceNumber: draft.referenceNumber || null,
        receiptId: draft.receiptId,
        releasedBy: null,
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
      onIssued();
    },
    onError: (error: unknown) =>
      toast.error('Could not record that release', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  const mode = Number(draft.disbursementMode) as DisbursementMode;

  // Case-insensitive and trimmed, because "BDO-4417" and "bdo-4417 " are the
  // same slip typed by two people. Compared against what the summary already
  // holds, so it costs no request.
  const typedReference = draft.referenceNumber.trim().toLowerCase();
  const alreadyOnThisTrip =
    typedReference.length > 0 &&
    summary.allowances.some(
      (release) => (release.referenceNumber ?? '').trim().toLowerCase() === typedReference,
    );

  if (crew.length === 0) {
    return (
      <p className="text-muted-foreground border-t pt-4 text-xs">
        Assign a driver before releasing cash — an allowance names the person accountable for this
        trip&apos;s money.
      </p>
    );
  }

  return (
    <form
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        issue.mutate();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="allowance-account" className="text-xs">
          Booked against
        </Label>
        <Select
          value={liquidationId}
          onValueChange={(value) => setDraft((current) => ({ ...current, liquidationId: value }))}
        >
          <SelectTrigger id="allowance-account">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            {open.map((account) => (
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
        <p className="text-muted-foreground text-[11px]">
          Whose variance this moves. Not necessarily the person it is handed to — a helper can be
          given ferry money the driver answers for.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="allowance-crew" className="text-xs">
            Released to
          </Label>
          <Select
            value={draft.staffId}
            onValueChange={(value) => setDraft((current) => ({ ...current, staffId: value }))}
          >
            <SelectTrigger id="allowance-crew">
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
          <Label htmlFor="allowance-amount" className="text-xs">
            Amount
          </Label>
          <Input
            id="allowance-amount"
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
          <Label htmlFor="allowance-issued-at" className="text-xs">
            Released on
          </Label>
          <Input
            id="allowance-issued-at"
            type="date"
            required
            value={draft.issuedAt}
            onChange={(event) =>
              setDraft((current) => ({ ...current, issuedAt: event.target.value }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="allowance-mode" className="text-xs">
            Released by
          </Label>
          <Select
            value={draft.disbursementMode}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, disbursementMode: value }))
            }
          >
            <SelectTrigger id="allowance-mode">
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
      </div>

      <div className="space-y-1">
        <Label htmlFor="allowance-reference" className="text-xs">
          Reference
        </Label>
        <Input
          id="allowance-reference"
          // Never required, whatever the mode: cash in the yard has none, and
          // a mandatory field is answered with an invented reference.
          placeholder={expectsReferenceNumber(mode) ? 'Transaction reference' : 'Optional'}
          value={draft.referenceNumber}
          onChange={(event) =>
            setDraft((current) => ({ ...current, referenceNumber: event.target.value }))
          }
        />
        {/* Checked against this trip's releases as it is typed — the case the
            person can still fix without saving anything. Releases on OTHER
            trips are caught too, but only by the server, which is what the
            warning on the rows above reports. */}
        {alreadyOnThisTrip ? (
          <p className="text-destructive flex items-center gap-1 text-[11px]">
            <AlertTriangle className="h-3 w-3" />A release on this trip already carries that
            reference. Record it anyway if one transfer covered both.
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

      <Button type="submit" size="sm" disabled={issue.isPending || !liquidationId}>
        {issue.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Record release
      </Button>
    </form>
  );
}
