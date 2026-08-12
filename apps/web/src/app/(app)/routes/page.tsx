'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { routeResource } from '@/lib/resources';

export default function Page() {
  return <ResourcePage spec={routeResource} />;
}
