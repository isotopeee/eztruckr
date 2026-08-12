'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { truckResource } from '@/lib/resources';

export default function Page() {
  return <ResourcePage spec={truckResource} />;
}
