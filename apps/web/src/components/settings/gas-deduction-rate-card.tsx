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
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-current-user';

export const GAS_DEDUCTION_FIELD = 'gasExpenseDeductionRate';

/**
 * The gas expense deduction rate — one value, edited from wherever you happen
 * to be thinking about it.
 *
 * WHY THIS IS A COMPONENT AND NOT TWO FORMS. The rate belongs on the settings
 * screen because it is a system-wide setting, and on the commission rules
 * screen because it is an input to the same computation those rules feed. The
 * temptation is to build it twice. Building it once means both placements read
 * and write the same `SystemSetting` row through the same query key, so a
 * change made on either screen is immediately correct on the other, and there
 * is exactly one place for this to go wrong.
 *
 * That is the whole point of the change this shipped with: commission rates
 * used to live in two tables, and the second one silently won when the first
 * had a gap. Surfacing one value twice is fine. Storing it twice is not.
 *
 * Administrator-only, matching the rest of `/api/settings`. Non-administrators
 * render nothing rather than a disabled form, and fire no request that could
 * only come back 403.
 */
export function GasDeductionRateCard({ description }: { description?: string }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const isAdministrator = user?.role === UserRole.ADMINISTRATOR;

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<SystemSetting>('/settings'),
    enabled: isAdministrator,
  });

  const history = useQuery({
    queryKey: ['settings', 'history'],
    queryFn: () => apiFetch<SettingChange[]>('/settings/history'),
    enabled: isAdministrator,
  });

  // Seeded once per load of the settings, so a background refetch never
  // overwrites what someone is typing.
  useEffect(() => {
    if (!settings.data) return;
    setDraft(settings.data.gasExpenseDeductionRate);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (value: string) =>
      apiFetch<SystemSetting>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ [GAS_DEDUCTION_FIELD]: value }),
      }),
    onSuccess: async () => {
      toast.success('Gas deduction rate saved');
      setFieldError(null);
      // Invalidating the shared keys is what keeps the other screen honest.
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFieldError(error.fieldErrors[GAS_DEDUCTION_FIELD] ?? null);
        toast.error(error.displayMessage);
        return;
      }
      toast.error('Something went wrong');
    },
  });

  if (!isAdministrator) {
    return null;
  }

  const lastChange = history.data?.find((change) => change.field === GAS_DEDUCTION_FIELD);
  const isUnchanged = draft === settings.data?.gasExpenseDeductionRate;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gas expense deduction rate</CardTitle>
        <CardDescription>
          {description ??
            'Applies to every commission: this share of fuel spend is deducted before the commissionable base.'}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {settings.isPending ? (
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(draft);
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor={GAS_DEDUCTION_FIELD} className="sr-only">
                  Gas expense deduction rate
                </Label>
                <Input
                  id={GAS_DEDUCTION_FIELD}
                  inputMode="decimal"
                  className="w-40"
                  disabled={save.isPending}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>

              <Button type="submit" disabled={save.isPending || isUnchanged}>
                {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Save
              </Button>
            </div>

            {fieldError ? (
              <p className="text-destructive text-xs">{fieldError}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                A multiplier between 0 and 1, stored to four decimal places — 0.2500 is 25%.
              </p>
            )}

            {/* Commissions freeze the rate they used, so a change never moves
                money already computed. Saying who last moved it, and from what,
                is what makes a questioned payout answerable. */}
            {lastChange ? (
              <p className="text-muted-foreground text-xs">
                Last changed by {lastChange.actorName ?? 'an unknown user'} on{' '}
                {formatDateTime(lastChange.occurredAt)} — was {lastChange.previousValue ?? '—'}.
              </p>
            ) : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
