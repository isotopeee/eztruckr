'use client';

import { ResourcePage } from '@/components/master-data/resource-page';
import { staffResource } from '@/lib/resources';

export default function Page() {
  return <ResourcePage spec={staffResource} />;
}
