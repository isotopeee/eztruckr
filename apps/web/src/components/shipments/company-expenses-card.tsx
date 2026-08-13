'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRole, type ExpenseCategory, type Page, type Shipment } from '@eztruckr/types';
import { Loader2, Paperclip, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ReceiptField } from '@/components/shipments/receipt-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import {
  addCompanyPaidExpense,
  listCompanyPaidExpenses,
  removeCompanyPaidExpense,
  shipmentKeys,
} from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * Costs the company paid directly — never advanced to the crew, so never
 * liquidated.
 *
 * ITS OWN CARD, beside the charges rather than inside them, because a reader
 * has to be able to tell at a glance which side of the P&L a line is on. A
 * billable expense is money coming back from the client; this is money that has
 * simply gone. Merging the two lists would put revenue and cost under one
 * heading, and the gross profit card below would then be unexplainable from
 * what is on screen.
 *
 * No commissionable switch, and that absence is the point: these feed the
 * crew's commission base not at all.
 */
export function CompanyExpensesCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const canEdit = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  const [draft, setDraft] = useState({
    expenseCategoryId: '',
    description: '',
    amount: '',
    spentAt: new Date().toISOString().slice(0, 10),
    receiptId: null as string | null,
    receiptFileName: null as string | null,
  });

  const expenses = useQuery({
    queryKey: shipmentKeys.companyExpenses(shipment.id),
    queryFn: () => listCompanyPaidExpenses(shipment.id),
  });

  const categories = useQuery({
    queryKey: ['expense-categories', 'selectable'],
    queryFn: () => apiFetch<Page<ExpenseCategory>>('/expense-categories?pageSize=200'),
    enabled: canEdit,
  });

  // Gross profit reads these rows, so it has to be refetched with them.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
  };

  const reportFailure = (error: unknown) =>
    toast.error('Could not save that expense', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });

  const add = useMutation({
    mutationFn: () =>
      addCompanyPaidExpense(shipment.id, {
        expenseCategoryId: draft.expenseCategoryId,
        description: draft.description || null,
        amount: draft.amount,
        // A date-only input means midnight local; sent as an instant because
        // storage is UTC and the display layer renders Asia/Manila.
        spentAt: new Date(draft.spentAt).toISOString(),
        receiptId: draft.receiptId,
      }),
    onSuccess: () => {
      setDraft((current) => ({
        ...current,
        description: '',
        amount: '',
        receiptId: null,
        receiptFileName: null,
      }));
      invalidate();
    },
    onError: reportFailure,
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeCompanyPaidExpense(shipment.id, id),
    onSuccess: invalidate,
    onError: reportFailure,
  });

  const rows = expenses.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Company-paid expenses</CardTitle>
        <CardDescription>
          Costs the company settled itself — fleet-card fuel, an office toll account, a workshop
          invoice. Not advanced to the crew, so nothing here is liquidated, and it counts as cost
          from the moment it is recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((expense) => (
              <li key={expense.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{expense.expenseCategoryName ?? 'Expense'}</p>
                  <p className="text-muted-foreground text-xs">
                    {formatDate(expense.spentAt)}
                    {expense.description ? ` · ${expense.description}` : ''}
                  </p>
                  {expense.receiptFileName ? (
                    <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                      <Paperclip className="h-3 w-3" />
                      {expense.receiptFileName}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatMoney(expense.amount)}</span>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${expense.expenseCategoryName ?? 'expense'}`}
                      onClick={() => remove.mutate(expense.id)}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="company-expense-category" className="text-xs">
                  Category
                </Label>
                <Select
                  value={draft.expenseCategoryId}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, expenseCategoryId: value }))
                  }
                >
                  <SelectTrigger id="company-expense-category">
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categories.data?.items ?? []).map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="company-expense-amount" className="text-xs">
                  Amount
                </Label>
                <Input
                  id="company-expense-amount"
                  placeholder="0.00"
                  inputMode="decimal"
                  required
                  value={draft.amount}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, amount: event.target.value }))
                  }
                />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="company-expense-spent-at" className="text-xs">
                  Paid on
                </Label>
                <Input
                  id="company-expense-spent-at"
                  type="date"
                  required
                  value={draft.spentAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, spentAt: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="company-expense-description" className="text-xs">
                  Description
                </Label>
                <Input
                  id="company-expense-description"
                  placeholder="Optional"
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
            </div>

            <ReceiptField
              value={draft.receiptId}
              fileName={draft.receiptFileName}
              label="Attach invoice"
              onChange={(receiptId, fileName) =>
                setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
              }
            />

            <Button type="submit" size="sm" disabled={add.isPending || !draft.expenseCategoryId}>
              {add.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Record expense
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
