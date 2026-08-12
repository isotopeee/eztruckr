'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { getRuleCoverage, shipmentKeys } from '@/lib/shipment-api';

/**
 * Warns when the rules needed to pay future shipments are missing or about to
 * lapse.
 *
 * There is no default commission rate in this system — a shipment matching no
 * rule is refused outright rather than paid at some invented figure. That is
 * the right behaviour and it has one drawback: the failure lands at month-end,
 * on somebody's real payout. This banner is the counterweight, surfacing the
 * same problem on a quiet afternoon while it is still cheap to fix.
 *
 * It renders nothing when coverage is fine, so it is silent almost always.
 */
export function RuleCoverageBanner() {
  const coverage = useQuery({
    queryKey: shipmentKeys.ruleCoverage,
    queryFn: getRuleCoverage,
    staleTime: 60_000,
  });

  const gaps = coverage.data?.gaps ?? [];

  if (gaps.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        Commission rule coverage
      </div>
      <ul className="space-y-1 text-sm">
        {gaps.map((gap) => (
          <li key={`${gap.role}-${gap.scope}`}>
            <span className="font-medium">{gap.roleLabel}:</span> {gap.reason}
            {gap.lapsesAt ? (
              <span className="text-muted-foreground"> Lapses {formatDate(gap.lapsesAt)}.</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
