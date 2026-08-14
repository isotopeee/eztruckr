'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { payeeResource } from '@/lib/resources';

export default function Page() {
  return <ResourcePage spec={payeeResource} />;
}
