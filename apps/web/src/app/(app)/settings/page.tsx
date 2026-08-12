'use client';

import { useQuery } from '@tanstack/react-query';
import { UserRole, type SettingChange } from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
import {
  GAS_DEDUCTION_FIELD,
  GasDeductionRateCard,
} from '@/components/settings/gas-deduction-rate-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-current-user';

const FIELD_LABELS: Record<string, string> = {
  [GAS_DEDUCTION_FIELD]: 'Gas expense deduction rate',

  // Retired. These columns were dropped when CommissionRule became the only
  // source of truth for crew pay, but entries recording changes to them stay
  // in the audit log — that is the point of an audit log. Keeping the labels
  // means the history reads as sentences rather than degrading into raw column
  // names the moment a field is removed.
  driverCommissionRate: 'Driver commission rate (retired)',
  helperCommissionRate: 'Helper commission rate (retired)',
};

/**
 * System settings, and the record of who changed them.
 *
 * The history below is the reason this screen exists rather than a plain
 * settings form: the gas deduction rate is an input to every commission the
 * system computes, and when someone questions a payout, "it was 0.2500 until
 * the 14th" has to be answerable.
 *
 * Commission rates are deliberately not here. CommissionRule is the only
 * source of truth for what crew are paid — see the note on the SystemSetting
 * model in schema.prisma.
 */
export default function SettingsPage() {
  const { user, isPending: userIsPending } = useCurrentUser();
  const isAdministrator = user?.role === UserRole.ADMINISTRATOR;

  const history = useQuery({
    queryKey: ['settings', 'history'],
    queryFn: () => apiFetch<SettingChange[]>('/settings/history'),
    enabled: isAdministrator,
  });

  if (userIsPending) {
    return <Loader2 className="text-muted-foreground size-5 animate-spin" />;
  }

  // The nav link is already administrator-only, so reaching this means someone
  // typed the URL. Say so plainly rather than rendering a form with every
  // control disabled, which reads as a bug.
  if (!isAdministrator) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Administrators only</CardTitle>
          <CardDescription>
            System settings are company financial policy. Ask an administrator if a rate needs to
            change.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">System settings</h1>
        <p className="text-muted-foreground text-sm">
          Changing a rate never alters a commission already computed — every shipment freezes the
          values it actually used.
        </p>
      </header>

      <GasDeductionRateCard />

      <Card>
        <CardHeader>
          <CardTitle>Change history</CardTitle>
          <CardDescription>Who changed what, when, and what it was before.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Setting</TableHead>
                <TableHead>Previous</TableHead>
                <TableHead>New</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data && history.data.length > 0 ? (
                history.data.map((change) => (
                  <TableRow key={change.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(change.occurredAt)}
                    </TableCell>
                    <TableCell>{change.actorName ?? '—'}</TableCell>
                    <TableCell>{FIELD_LABELS[change.field] ?? change.field}</TableCell>
                    <TableCell className="tabular-nums">{change.previousValue ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{change.newValue ?? '—'}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    No changes recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
