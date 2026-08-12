'use client';

import { useQuery } from '@tanstack/react-query';
import { CREW_ROLE_LABELS, type CrewMember } from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * The crew portal's one screen for now: your own crew record.
 *
 * The id comes from the session, never from the URL. The API checks it again
 * server-side — a crew login asking for someone else's id gets a 403 — so this
 * is convenience, not the control.
 */
export default function MyRecordPage() {
  const { user } = useCurrentUser();
  const crewMemberId = user?.crewMemberId ?? null;

  const record = useQuery({
    queryKey: ['crew-members', crewMemberId],
    queryFn: () => apiFetch<CrewMember>(`/crew-members/${crewMemberId}`),
    enabled: !!crewMemberId,
  });

  if (!user) return null;

  if (!crewMemberId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No crew record linked</CardTitle>
          <CardDescription>
            This login is not linked to a crew member. An administrator can link it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My record</h1>
        <p className="text-muted-foreground text-sm">
          Contact an administrator to correct anything here.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {record.data ? `${record.data.firstName} ${record.data.lastName}` : 'Crew record'}
            {record.data ? (
              <Badge variant={record.data.isActive ? 'secondary' : 'outline'}>
                {record.data.isActive ? 'Active' : 'Inactive'}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>{record.data?.employeeCode}</CardDescription>
        </CardHeader>
        <CardContent>
          {record.isPending ? (
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          ) : record.isError ? (
            <p className="text-destructive text-sm">
              {record.error instanceof ApiError
                ? record.error.displayMessage
                : 'Could not load your record'}
            </p>
          ) : record.data ? (
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Row label="Eligible as">
                {record.data.eligibleRoles.map((role) => CREW_ROLE_LABELS[role]).join(', ') || '—'}
              </Row>
              <Row label="Phone">{record.data.phone ?? '—'}</Row>
              <Row label="Address">{record.data.address ?? '—'}</Row>
              <Row label="Date hired">
                {record.data.dateHired ? formatDate(record.data.dateHired) : '—'}
              </Row>
              <Row label="Licence number">{record.data.licenseNumber ?? '—'}</Row>
              <Row label="Licence expiry">
                {record.data.licenseExpiry ? formatDate(record.data.licenseExpiry) : '—'}
              </Row>
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
