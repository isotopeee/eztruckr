'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISBURSEMENT_MODE_LABELS,
  DisbursementMode,
  liquidationAccountLabel,
  SETTLEMENT_STATUS_LABELS,
  SettlementStatus,
  UserRole,
  type Settlement,
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
  liquidationKeys,
  listSettlements,
  receiptContentUrl,
  recordSettlement,
} from '@/lib/liquidation-api';
import { shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { useTripCashHolders } from './trip-cash-holders';
import { ReceiptField } from './receipt-field';

/**
 * What happened to the cash left over, per person who was holding it.
 *
 * This card and the liquidation card answer different questions, which is why
 * they are not merged: the liquidation says the spending was accounted for, and
 * this says whether the change came back. An account can be approved and still
 * owe the company ₱1,400.
 *
 * ONE ROW PER CUSTODIAN, not per trip. A single settlement could only report
 * what the TRIP was short by, so the driver squaring up and the helper still
 * holding ₱900 were one blended figure that named nobody — and squaring up was
 * all-or-nothing for both of them.
 */
export function SettlementCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const canSettle = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const settlements = useQuery({
    queryKey: liquidationKeys.settlements(shipment.id),
    queryFn: () => listSettlements(shipment.id),
    // No settlement until an account is approved. Ordinary, not an error.
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: liquidationKeys.all });
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const rows = settlements.data ?? [];

  if (settlements.isPending || settlements.isError || rows.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settlements</CardTitle>
        <CardDescription>
          The variance from each approved liquidation, and how it moved. One record per cash holder
          — with two people carrying change, a single figure could say what the trip was short by
          and never who owed it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {rows.map((settlement) => (
          <SettlementRow
            key={settlement.id}
            shipment={shipment}
            settlement={settlement}
            canSettle={canSettle}
            onChanged={invalidate}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function SettlementRow({
  shipment,
  settlement,
  canSettle,
  onChanged,
}: {
  shipment: Shipment;
  settlement: Settlement;
  canSettle: boolean;
  onChanged: () => void;
}) {
  const crewOwes = !settlement.amount.startsWith('-');

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* The person AND which of their accounts: one custodian can hold
            several on a trip, so two settlements here can carry the same name
            and different figures. */}
        <h3 className="text-sm font-medium">
          {liquidationAccountLabel(settlement.custodianName, settlement.liquidationSequence)}
        </h3>
        <Badge variant={settlement.isOutstanding ? 'outline' : 'secondary'}>
          {SETTLEMENT_STATUS_LABELS[settlement.status]}
        </Badge>
      </div>

      <div className="flex items-baseline justify-between border-b pb-3">
        <span className="text-muted-foreground text-sm">
          {crewOwes ? 'Crew return' : 'Company reimburses crew'}
        </span>
        <span className="text-lg font-semibold tabular-nums">{formatMoney(settlement.amount)}</span>
      </div>

      {settlement.settledAt ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Settled</dt>
            <dd>{formatDateTime(settlement.settledAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Moved by</dt>
            <dd>
              {settlement.disbursementMode
                ? DISBURSEMENT_MODE_LABELS[settlement.disbursementMode]
                : settlement.crewDeductionId
                  ? 'Recovered from pay'
                  : 'Nothing to move'}
            </dd>
          </div>
          {settlement.referenceNumber ? (
            <div>
              <dt className="text-muted-foreground text-xs">Reference</dt>
              <dd>{settlement.referenceNumber}</dd>
            </div>
          ) : null}
          {settlement.receiptId ? (
            <div>
              <dt className="text-muted-foreground text-xs">Proof</dt>
              <dd>
                <a
                  className="underline underline-offset-4"
                  href={receiptContentUrl(settlement.receiptId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {settlement.receiptFileName ?? 'Attachment'}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {settlement.status === SettlementStatus.CARRIED_TO_PAYOUT ? (
        <p className="text-muted-foreground text-sm">
          Being recovered from the crew member&apos;s pay
          {settlement.crewDeductionRecovered
            ? ` — ${formatMoney(settlement.crewDeductionRecovered)} taken so far`
            : ''}
          . This trip stays on the outstanding list until the payout run recovering it is paid.
        </p>
      ) : null}

      {canSettle && settlement.status === SettlementStatus.OUTSTANDING ? (
        <SettleForm
          shipment={shipment}
          settlement={settlement}
          crewOwes={crewOwes}
          onChanged={onChanged}
        />
      ) : null}
    </section>
  );
}

function SettleForm({
  shipment,
  settlement,
  crewOwes,
  onChanged,
}: {
  shipment: Shipment;
  settlement: Settlement;
  crewOwes: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState(String(DisbursementMode.CASH));
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<{ id: string | null; fileName: string | null }>({
    id: null,
    fileName: null,
  });
  // Deliberately empty. Who a carried balance is charged to is asked, never
  // guessed — and now that the account names a custodian the temptation is
  // worse, not better: they are answerable for ACCOUNTING for the cash, which
  // is not the same as the company having decided to take it out of their pay.
  const [carryTo, setCarryTo] = useState('');

  const reportFailure = (error: unknown) =>
    toast.error('That did not go through', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const record = useMutation({
    mutationFn: () =>
      recordSettlement(settlement.liquidationId, {
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
    mutationFn: () =>
      carrySettlementToPayout(settlement.liquidationId, {
        staffId: carryTo,
        reason: null,
      }),
    onSuccess: () => {
      toast.success('Carried to payout');
      onChanged();
    },
    onError: reportFailure,
  });

  const crew = useTripCashHolders(shipment);

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
            <Label htmlFor={`settlement-mode-${settlement.id}`} className="text-xs">
              Moved by
            </Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger id={`settlement-mode-${settlement.id}`}>
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
            <Label htmlFor={`settlement-reference-${settlement.id}`} className="text-xs">
              Reference
            </Label>
            <Input
              id={`settlement-reference-${settlement.id}`}
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
            <Label htmlFor={`settlement-carry-${settlement.id}`} className="text-xs">
              Or recover it from pay — whose?
            </Label>
            <Select value={carryTo} onValueChange={setCarryTo}>
              <SelectTrigger id={`settlement-carry-${settlement.id}`}>
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
            <p className="text-muted-foreground text-[11px]">
              Creates a crew deduction. Nothing is preselected: this account is
              {settlement.custodianName ? ` ${settlement.custodianName}'s` : ' unassigned'} to
              explain, but whose pay the company takes it out of is a decision, not a lookup.
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
