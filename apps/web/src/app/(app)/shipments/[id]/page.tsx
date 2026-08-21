'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { SHIPMENT_STATUS_LABELS, UserRole } from '@eztruckr/types';
import { ArrowLeft } from 'lucide-react';
import { AllowanceRequestsCard } from '@/components/shipments/allowance-requests-card';
import { AllowancesCard } from '@/components/shipments/allowances-card';
import { BookingDetailsDialog } from '@/components/shipments/booking-details-dialog';
import { ChargesCard } from '@/components/shipments/charges-card';
import { CommissionsCard } from '@/components/shipments/commissions-card';
import { CompanyExpensesCard } from '@/components/shipments/company-expenses-card';
import { CrewAndLifecycleCard } from '@/components/shipments/crew-and-lifecycle-card';
import { GasRateOverrideCard } from '@/components/shipments/gas-rate-override-card';
import { GrossProfitCard } from '@/components/shipments/gross-profit-card';
import { LiquidationCard } from '@/components/shipments/liquidation-card';
import { PaymentsCard } from '@/components/shipments/payments-card';
import { RateChainCard } from '@/components/shipments/rate-chain-card';
import { SettlementCard } from '@/components/shipments/settlement-card';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { getShipment, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useCurrentUser();

  const shipment = useQuery({
    queryKey: shipmentKeys.detail(id),
    queryFn: () => getShipment(id),
  });

  if (shipment.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  if (shipment.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-destructive text-sm">
          {shipment.error instanceof ApiError
            ? shipment.error.displayMessage
            : 'Could not load this shipment.'}
        </p>
      </div>
    );
  }

  const data = shipment.data;
  const isCrew = user?.role === UserRole.CREW;

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{data.shipmentNumber}</h1>
            <Badge>{SHIPMENT_STATUS_LABELS[data.status]}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {formatDate(data.shipmentDate)} · {data.clientName} · {data.origin} → {data.destination}
            {/* Named beside the lane it filled in, now that it is editable
                here: a route swap that left the lane behind would otherwise be
                invisible on the screen it happened on. */}
            {data.routeName ? ` · ${data.routeName}` : ''}
            {data.thirdPartyName ? ` · via ${data.thirdPartyName}` : ''}
            {/* Beside the lane rather than in a card of its own: it is how
                somebody on the phone identifies the trip, so it belongs where
                the trip is identified. */}
            {data.containerNumber ? ` · container ${data.containerNumber}` : ''}
          </p>
        </div>
        {/* Office-only and status-gated, both decided inside the component so a
            crew session cannot be shown an edit it would be refused. */}
        {isCrew ? null : <BookingDetailsDialog shipment={data} />}
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <RateChainCard shipment={data} />
          {/* The crew's half of the trip's cash: what they were given, and what
              they spent it on. Both are theirs to see and one is theirs to
              fill in, so neither is hidden from a crew session. */}
          <LiquidationCard shipment={data} />
          {/* Office-only. A crew member's pay is not shown in the portal at
              all — see the crew-visibility table in HANDOFF.md, including what
              that costs them. The API refuses the routes behind this card too,
              so removing it is presentation following the control. */}
          {isCrew ? null : <CommissionsCard shipment={data} />}
        </div>
        <div className="space-y-6">
          {/* A crew member sees their own pay and the trip, not the levers
              that move either. */}
          {isCrew ? null : (
            <>
              <CrewAndLifecycleCard shipment={data} />
              {/* Above the releases because that is the order it happens in:
                  dispatch asks here, accounting approves, and the approval
                  appears below as an ordinary release on the same account. */}
              <AllowanceRequestsCard shipment={data} />
              <AllowancesCard shipment={data} />
              <SettlementCard shipment={data} />
              <GasRateOverrideCard shipment={data} />
            </>
          )}
        </div>
      </div>

      {/* Below the fold and office-only: the trip's own P&L. A crew member sees
          their pay and their liquidation, both of which are their record; what
          the company made on the trip they drove is not. */}
      {isCrew ? null : (
        <>
          <ChargesCard shipment={data} />
          <CompanyExpensesCard shipment={data} />
          <GrossProfitCard shipment={data} />
          {/* Last, and after the profit rather than beside the charges: the
              order is what the trip earned, then what has actually come in.
              A payment is the collection of that revenue and never part of
              it — putting the two cards next to each other is what would
              invite somebody to add one to the other. */}
          <PaymentsCard shipment={data} />
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/shipments"
      className="text-muted-foreground inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
    >
      <ArrowLeft className="h-4 w-4" />
      All shipments
    </Link>
  );
}
