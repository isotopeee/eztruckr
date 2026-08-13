'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISBURSEMENT_MODE_LABELS,
  DisbursementMode,
  UserRole,
  expectsReferenceNumber,
  type Shipment,
} from '@eztruckr/types';
import { Loader2, Trash2 } from 'lucide-react';
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
import { ApiError } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import {
  getAllowances,
  issueAllowance,
  liquidationKeys,
  receiptContentUrl,
  removeAllowance,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { ReceiptField } from './receipt-field';

/**
 * Every release of cash on this trip, and the total they add up to.
 *
 * THERE IS NO "EDIT THE ALLOWANCE" BUTTON, and its absence is the design. A
 * trip carries an initial advance and whatever the road demands afterwards, so
 * a second release is a second row — with its own date, its own mode and its
 * own paper trail. A single editable figure would swallow the first one whole.
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
                    {release.crewMemberName ?? 'Crew'} · {formatDate(release.issuedAt)}
                  </p>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline">
                      {DISBURSEMENT_MODE_LABELS[release.disbursementMode]}
                    </Badge>
                    {release.referenceNumber ? <span>Ref {release.referenceNumber}</span> : null}
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
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove release"
                      onClick={() => remove.mutate(release.id)}
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

        {canIssueRole ? (
          data?.canIssue ? (
            <IssueForm shipment={shipment} summary={data} onIssued={invalidate} />
          ) : (
            <p className="text-muted-foreground border-t pt-4 text-xs">
              The liquidation for this trip is approved, so the total advanced is frozen. Reverse
              the approval, with a reason, to record another release.
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
  onIssued,
}: {
  shipment: Shipment;
  summary: { releaseCount: number; routeStandardAllowance: string | null };
  onIssued: () => void;
}) {
  const crew = [
    shipment.driverId ? { id: shipment.driverId, name: shipment.driverName ?? 'Driver' } : null,
    shipment.helperId ? { id: shipment.helperId, name: shipment.helperName ?? 'Helper' } : null,
  ].filter((entry): entry is { id: string; name: string } => entry !== null);

  // The route's standard allowance prefills the FIRST release only. A top-up is
  // whatever the road actually cost, and offering the standard figure again
  // would be suggesting a number nobody meant.
  const [draft, setDraft] = useState({
    crewMemberId: crew[0]?.id ?? '',
    amount: summary.releaseCount === 0 ? (summary.routeStandardAllowance ?? '') : '',
    disbursementMode: String(DisbursementMode.CASH),
    referenceNumber: '',
    receiptId: null as string | null,
    receiptFileName: null as string | null,
    remarks: '',
  });

  const issue = useMutation({
    mutationFn: () =>
      issueAllowance(shipment.id, {
        crewMemberId: draft.crewMemberId,
        amount: draft.amount,
        issuedAt: null,
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
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="allowance-crew" className="text-xs">
            Released to
          </Label>
          <Select
            value={draft.crewMemberId}
            onValueChange={(value) => setDraft((current) => ({ ...current, crewMemberId: value }))}
          >
            <SelectTrigger id="allowance-crew">
              <SelectValue placeholder="Crew member" />
            </SelectTrigger>
            <SelectContent>
              {crew.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
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
        </div>
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

      <Button type="submit" size="sm" disabled={issue.isPending}>
        {issue.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Record release
      </Button>
    </form>
  );
}
