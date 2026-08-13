'use client';

import { useQuery } from '@tanstack/react-query';
import type { Page, Payee } from '@eztruckr/types';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-client';

/**
 * Who the money went to, on any form that records a disbursement.
 *
 * Shared by the liquidation card and the company-expenses card for the same
 * reason `TripCashHolders` is shared: two pickers over one list drift, and the
 * one that drifts is always the one nobody was looking at.
 *
 * REQUIRED OR NOT DEPENDING ON THE EXPENSE CATEGORY, which is why `required`
 * is a prop rather than a constant: `ExpenseCategory.requiresPayee` decides,
 * the API enforces it, and this only mirrors the decision so the refusal lands
 * where the person can still act on it. When it is optional the "Not recorded"
 * choice comes back — a toll booth has no vendor worth a master record, and a
 * picker with no way out gets answered with whatever sits at the top.
 *
 * The list is active payees only, which is what `/payees` returns by default.
 * A deactivated vendor is still valid on rows that already name it — the API
 * checks existence, not `isActive` — it is simply no longer offered here.
 */

/** Radix forbids an empty-string item value, so absence needs a sentinel. */
const NONE = 'none';
export function PayeeField({
  id,
  value,
  onChange,
  required,
  disabled,
  label = 'Paid to',
}: {
  id: string;
  /** `''` means nothing chosen yet — the same sentinel the category selects use. */
  value: string;
  onChange: (payeeId: string) => void;
  /** From the chosen category's `requiresPayee`. */
  required: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const payees = useQuery({
    queryKey: ['payees', 'picker'],
    queryFn: () => apiFetch<Page<Payee>>('/payees?pageSize=200'),
    enabled: !disabled,
  });

  // Only worth saying when it would otherwise look broken: a required field
  // over an empty list is a permanently disabled button with no explanation.
  const blocked = required && !payees.isLoading && (payees.data?.items.length ?? 0) === 0;

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Select
        disabled={disabled}
        value={value === '' ? (required ? '' : NONE) : value}
        onValueChange={(next) => onChange(next === NONE ? '' : next)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={required ? 'Choose who was paid' : 'Not recorded'} />
        </SelectTrigger>
        <SelectContent>
          {required ? null : <SelectItem value={NONE}>Not recorded</SelectItem>}
          {(payees.data?.items ?? []).map((payee) => (
            <SelectItem key={payee.id} value={payee.id}>
              {payee.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {blocked ? (
        <p className="text-muted-foreground text-xs">
          This category requires a payee and none exist yet — add one under Operations → Payees.
        </p>
      ) : null}
    </div>
  );
}
