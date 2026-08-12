'use client';

import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@eztruckr/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

/**
 * Phase 1 smoke test rendered in the UI: proves the web app boots, TanStack
 * Query is wired, and the API + Postgres + MinIO are all reachable.
 */
export function HealthStatusCard() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/health'),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          API status
          {data ? (
            <Badge variant={data.status === 'ok' ? 'default' : 'destructive'}>{data.status}</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>Live health check from the NestJS API.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {isPending ? <p className="text-muted-foreground">Checking…</p> : null}

        {isError ? (
          <p className="text-destructive">
            Could not reach the API. Is it running on port 4000? ({(error as Error).message})
          </p>
        ) : null}

        {data ? (
          <dl className="grid grid-cols-2 gap-y-2">
            <dt className="text-muted-foreground">Database</dt>
            <dd className="font-mono">{data.checks.database}</dd>

            <dt className="text-muted-foreground">Object storage</dt>
            <dd className="font-mono">{data.checks.storage}</dd>

            <dt className="text-muted-foreground">Uptime</dt>
            <dd className="font-mono">{data.uptimeSeconds}s</dd>

            <dt className="text-muted-foreground">Checked at</dt>
            {/* Stored/transmitted as UTC, displayed in Asia/Manila. */}
            <dd className="font-mono">{formatDateTime(data.timestamp)}</dd>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}
