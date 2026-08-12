'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRole, type SettingChange, type SystemSetting } from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-current-user';

const RATE_FIELDS = [
  {
    name: 'gasExpenseDeductionRate' as const,
    label: 'Gas expense deduction rate',
    help: 'The share of fuel spend deducted before commission is computed. 0.2500 is 25%.',
  },
  {
    name: 'driverCommissionRate' as const,
    label: 'Driver commission rate',
    help: 'Fallback used when no commission rule matches.',
  },
  {
    name: 'helperCommissionRate' as const,
    label: 'Helper commission rate',
    help: 'Fallback used when no commission rule matches.',
  },
];

/**
 * System settings, and the record of who changed them.
 *
 * The history below the form is the reason this screen exists rather than a
 * plain settings form: these rates are inputs to every commission the system
 * computes, and when someone questions a payout, "it was 0.2500 until the 14th"
 * has to be answerable.
 */
export default function SettingsPage() {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isAdministrator = user?.role === UserRole.ADMINISTRATOR;

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<SystemSetting>('/settings'),
  });

  const history = useQuery({
    queryKey: ['settings', 'history'],
    queryFn: () => apiFetch<SettingChange[]>('/settings/history'),
    enabled: isAdministrator,
  });

  // Seed the form from the server exactly once per load of the settings, so
  // typing is never overwritten by a background refetch.
  useEffect(() => {
    if (!settings.data) return;
    setDraft({
      gasExpenseDeductionRate: settings.data.gasExpenseDeductionRate,
      driverCommissionRate: settings.data.driverCommissionRate,
      helperCommissionRate: settings.data.helperCommissionRate,
    });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (payload: Record<string, string>) =>
      apiFetch<SystemSetting>('/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
    onSuccess: async () => {
      toast.success('Settings saved');
      setFieldErrors({});
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.displayMessage);
        return;
      }
      toast.error('Something went wrong');
    },
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">System settings</h1>
        <p className="text-muted-foreground text-sm">
          Rates used when computing commissions. Changing one never alters a commission already
          computed — every shipment freezes the values it actually used.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Rates</CardTitle>
          <CardDescription>
            Each is a multiplier between 0 and 1, stored to four decimal places.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings.isPending ? (
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate(draft);
              }}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                {RATE_FIELDS.map((field) => (
                  <div key={field.name} className="space-y-2">
                    <Label htmlFor={field.name}>{field.label}</Label>
                    <Input
                      id={field.name}
                      inputMode="decimal"
                      disabled={!isAdministrator || save.isPending}
                      value={draft[field.name] ?? ''}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, [field.name]: event.target.value }))
                      }
                    />
                    {fieldErrors[field.name] ? (
                      <p className="text-destructive text-xs">{fieldErrors[field.name]}</p>
                    ) : (
                      <p className="text-muted-foreground text-xs">{field.help}</p>
                    )}
                  </div>
                ))}
              </div>

              {isAdministrator ? (
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save settings
                </Button>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Only an administrator may change these.
                </p>
              )}
            </form>
          )}
        </CardContent>
      </Card>

      {isAdministrator ? (
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
                      <TableCell>{labelFor(change.field)}</TableCell>
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
      ) : null}
    </div>
  );
}

function labelFor(field: string): string {
  return RATE_FIELDS.find((entry) => entry.name === field)?.label ?? field;
}
