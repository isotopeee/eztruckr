'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISBURSEMENT_MODE_LABELS,
  DisbursementMode,
  SETTLEMENT_STATUS_LABELS,
  SettlementStatus,
  UserRole,
  type Shipment,
} from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
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
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  carrySettlementToPayout,
  getSettlement,
  liquidationKeys,
  receiptContentUrl,
  recordSettlement,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { ReceiptField } from './receipt-field';

/**
 * What happened to the cash left over.
 *
 * This card and the liquidation card answer different questions, which is why
 * they are not merged: the liquidation says the spending was accounted for, and
 * this says whether the change came back. A trip can be approved and still owe
 * the company ₱1,400.
 */
export function SettlementCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const canSettle = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const settlement = useQuery({
    queryKey: liquidationKeys.settlement(shipment.id),
    queryFn: () => getSettlement(shipment.id),
    // No settlement until the liquidation is approved. Ordinary, not an error.
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: liquidationKeys.all });
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  if (settlement.isPending) {
    return null;
  }

  if (settlement.isError || !settlement.data) {
    return null;
  }

  const data = settlement.data;
  const crewOwes = !data.amount.startsWith('-');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle className="text-base">Settlement</CardTitle>
          <Badge variant={data.isOutstanding ? 'outline' : 'secondary'}>
            {SETTLEMENT_STATUS_LABELS[data.status]}
          </Badge>
        </div>
        <CardDescription>
          The variance from the approved liquidation, and how it moved. One record for the trip —
          with several advances there is no honest way to say which one a returned amount came from.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between border-b pb-3">
          <span className="text-muted-foreground text-sm">
            {crewOwes ? 'Crew return' : 'Company reimburses crew'}
          </span>
          <span className="text-lg font-semibold tabular-nums">{formatMoney(data.amount)}</span>
        </div>

        {data.settledAt ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Settled</dt>
              <dd>{formatDateTime(data.settledAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Moved by</dt>
              <dd>
                {data.disbursementMode
                  ? DISBURSEMENT_MODE_LABELS[data.disbursementMode]
                  : data.crewDeductionId
                    ? 'Recovered from pay'
                    : 'Nothing to move'}
              </dd>
            </div>
            {data.referenceNumber ? (
              <div>
                <dt className="text-muted-foreground text-xs">Reference</dt>
                <dd>{data.referenceNumber}</dd>
              </div>
            ) : null}
            {data.receiptId ? (
              <div>
                <dt className="text-muted-foreground text-xs">Proof</dt>
                <dd>
                  <a
                    className="underline underline-offset-4"
                    href={receiptContentUrl(data.receiptId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {data.receiptFileName ?? 'Attachment'}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {data.status === SettlementStatus.CARRIED_TO_PAYOUT ? (
          <p className="text-muted-foreground text-sm">
            Being recovered from the crew member&apos;s pay
            {data.crewDeductionRecovered
              ? ` — ${formatMoney(data.crewDeductionRecovered)} taken so far`
              : ''}
            . This trip stays on the outstanding list until the payout run recovering it is paid.
          </p>
        ) : null}

        {canSettle && data.status === SettlementStatus.OUTSTANDING ? (
          <SettleForm shipment={shipment} crewOwes={crewOwes} onChanged={invalidate} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function SettleForm({
  shipment,
  crewOwes,
  onChanged,
}: {
  shipment: Shipment;
  crewOwes: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState(String(DisbursementMode.CASH));
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<{ id: string | null; fileName: string | null }>({
    id: null,
    fileName: null,
  });
  const [carryTo, setCarryTo] = useState(shipment.driverId ?? '');

  const reportFailure = (error: unknown) =>
    toast.error('That did not go through', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const record = useMutation({
    mutationFn: () =>
      recordSettlement(shipment.id, {
        disbursementMode: Number(mode) as DisbursementMode,
        referenceNumber: reference || null,
        receiptId: receipt.id,
        remarks: null,
      }),
    onSuccess: () => {
      toast.success('Settlement recorded');
      onChanged();
    },
    onError: reportFailure,
  });

  const carry = useMutation({
    mutationFn: () => carrySettlementToPayout(shipment.id, { crewMemberId: carryTo, reason: null }),
    onSuccess: () => {
      toast.success('Carried to payout');
      onChanged();
    },
    onError: reportFailure,
  });

  const crew = [
    shipment.driverId ? { id: shipment.driverId, name: shipment.driverName ?? 'Driver' } : null,
    shipment.helperId ? { id: shipment.helperId, name: shipment.helperName ?? 'Helper' } : null,
  ].filter((entry): entry is { id: string; name: string } => entry !== null);

  return (
    <div className="space-y-4 border-t pt-4">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          record.mutate();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="settlement-mode" className="text-xs">
              Moved by
            </Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger id="settlement-mode">
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
            <Label htmlFor="settlement-reference" className="text-xs">
              Reference
            </Label>
            <Input
              id="settlement-reference"
              placeholder="Optional"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
        </div>

        <ReceiptField
          value={receipt.id}
          fileName={receipt.fileName}
          label="Attach proof"
          onChange={(id, fileName) => setReceipt({ id, fileName })}
        />

        <Button type="submit" size="sm" disabled={record.isPending}>
          {record.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Record the movement
        </Button>
      </form>

      {/* Only offered when the crew owe the company. A payout run recovers
          debts; money the company owes is handed over, and there is nothing for
          a run to take. The API refuses it either way. */}
      {crewOwes && crew.length > 0 ? (
        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            carry.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="settlement-carry" className="text-xs">
              Or recover it from pay — whose?
            </Label>
            <Select value={carryTo} onValueChange={setCarryTo}>
              <SelectTrigger id="settlement-carry">
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
            <p className="text-muted-foreground text-[11px]">
              Creates a crew deduction. Nothing is guessed here: the settlement belongs to the trip,
              but a deduction has to name a person.
            </p>
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={carry.isPending || !carryTo}>
            {carry.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Carry to payout
          </Button>
        </form>
      ) : null}
    </div>
  );
}
