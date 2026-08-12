'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { GasDeductionRateCard } from '@/components/settings/gas-deduction-rate-card';
import { commissionRuleResource } from '@/lib/resources';

/**
 * Commission rules, with the gas deduction rate above them.
 *
 * The rate is not a commission rule and is not stored as one — it is the single
 * system-wide value, rendered here because this is where someone reasoning
 * about commission maths actually is. Editing it here and editing it on the
 * settings screen write the same row.
 */
export default function Page() {
  return (
    <div className="space-y-6">
      <GasDeductionRateCard description="Deducted from fuel spend before the commissionable base every rule below is applied to. One system-wide value — editing it here is the same as editing it in System settings." />
      <ResourcePage spec={commissionRuleResource} />
    </div>
  );
}
