'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { SHIPMENT_STATUS_LABELS, UserRole } from '@eztruckr/types';
import { ArrowLeft } from 'lucide-react';
import { AllowancesCard } from '@/components/shipments/allowances-card';
import { ChargesCard } from '@/components/shipments/charges-card';
import { CommissionsCard } from '@/components/shipments/commissions-card';
import { CrewAndLifecycleCard } from '@/components/shipments/crew-and-lifecycle-card';
import { GasRateOverrideCard } from '@/components/shipments/gas-rate-override-card';
import { LiquidationCard } from '@/components/shipments/liquidation-card';
import { RateChainCard } from '@/components/shipments/rate-chain-card';
import { SettlementCard } from '@/components/shipments/settlement-card';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api-client';
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
            {data.clientName} · {data.origin} → {data.destination}
            {data.thirdPartyName ? ` · via ${data.thirdPartyName}` : ''}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <RateChainCard shipment={data} />
          {/* The crew's half of the trip's cash: what they were given, and what
              they spent it on. Both are theirs to see and one is theirs to
              fill in, so neither is hidden from a crew session. */}
          <LiquidationCard shipment={data} />
          <CommissionsCard shipment={data} />
        </div>
        <div className="space-y-6">
          {/* A crew member sees their own pay and the trip, not the levers
              that move either. */}
          {isCrew ? null : (
            <>
              <CrewAndLifecycleCard shipment={data} />
              <AllowancesCard shipment={data} />
              <SettlementCard shipment={data} />
              <GasRateOverrideCard shipment={data} />
            </>
          )}
        </div>
      </div>

      {isCrew ? null : <ChargesCard shipment={data} />}
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
