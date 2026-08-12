'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { commissionRuleResource } from '@/lib/resources';

export default function Page() {
  return <ResourcePage spec={commissionRuleResource} />;
}
