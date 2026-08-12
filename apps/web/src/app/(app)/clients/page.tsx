'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { clientResource } from '@/lib/resources';

export default function Page() {
  return <ResourcePage spec={clientResource} />;
}
