'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserRole,
  type ExpenseCategory,
  type OperationExpense,
  type Page as PageResult,
} from '@eztruckr/types';
import { Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { PayeeField } from '@/components/shipments/payee-field';
import { ReceiptField } from '@/components/shipments/receipt-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatMoney, toDateInputValue } from '@/lib/format';
import { PAGE_ROLES } from '@/lib/nav';
import {
  addOperationExpense,
  listOperationExpenses,
  operationExpenseKeys,
  removeOperationExpense,
  updateOperationExpense,
  type OperationExpenseFilters,
} from '@/lib/operation-expense-api';
import { summariseOperationExpenses } from '@/lib/operation-expense-api';
import { useCurrentUser } from '@/lib/use-current-user';

const ALL = '__all__';

/**
 * Widened from the `PAGE_ROLES` tuple, which infers as its literal members and
 * so refuses `includes` against any other role. The same list, read the way
 * `ResourceSpec.pageRoles` already declares it.
 */
const MAY_OPEN: readonly UserRole[] = PAGE_ROLES.operationExpenses;

/**
 * What it costs to keep the company open.
 *
 * READ AS A MONTH, not as a date range, and the month picker is the reason
 * there is no inclusive/exclusive question on this screen. The API's window is
 * half-open — `from` counts, `to` does not — which is right for tiling
 * consecutive periods and is a trap to hand to somebody typing two dates: "to
 * 31 August" would quietly drop the 31st. Choosing a MONTH means the page
 * computes both bounds and the user never meets the edge.
 *
 * THE TOTAL SITS ABOVE THE TABLE AND DESCRIBES IT. Both come from the same
 * filter, and the API computes both from one `where` for the same reason — a
 * heading that totals a different set of rows than the table under it is worse
 * than no heading.
 *
 * NOT A `ResourceSpec`, unlike the eight screens beside it in the nav. Those
 * are directories: searchable, `isActive`, and removable-or-deactivatable. This
 * is a ledger read by period with a running total, and bending the declarative
 * machinery to it would have meant adding a date window, a summary row and a
 * conditional payee field to a component whose whole value is that eight
 * screens share it unmodified.
 */
export default function Page() {
  const { user, isPending: userPending } = useCurrentUser();
  const queryClient = useQueryClient();

  const mayOpen = !!user && MAY_OPEN.includes(user.role);
  const canWrite = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  // Manila's current month, not the browser's — `toDateInputValue` is already
  // the timezone-correct answer and slicing its `YYYY-MM-DD` is the month.
  const [month, setMonth] = useState(() => toDateInputValue(new Date().toISOString()).slice(0, 7));
  const [categoryFilter, setCategoryFilter] = useState(ALL);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<OperationExpense | null>(null);
  const [creating, setCreating] = useState(false);

  const filters: OperationExpenseFilters = {
    ...monthWindow(month),
    expenseCategoryId: categoryFilter === ALL ? undefined : categoryFilter,
    search: search || undefined,
  };

  const expenses = useQuery({
    queryKey: operationExpenseKeys.list(filters),
    queryFn: () => listOperationExpenses(filters),
    enabled: mayOpen,
  });

  const summary = useQuery({
    queryKey: operationExpenseKeys.summary(filters),
    queryFn: () => summariseOperationExpenses(filters),
    enabled: mayOpen,
  });

  const categories = useQuery({
    // Overhead categories only — the mirror of the three trip-side pickers.
    // A category has to be OFFERED here before it can be filed against here.
    queryKey: ['expense-categories', 'selectable', 'overhead'],
    queryFn: () =>
      apiFetch<PageResult<ExpenseCategory>>('/expense-categories?pageSize=200&offeredFor=overhead'),
    enabled: mayOpen,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: operationExpenseKeys.all });

  const remove = useMutation({
    mutationFn: (id: string) => removeOperationExpense(id),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      toast.error('Could not remove that expense', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      }),
  });

  if (!userPending && !mayOpen) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Operation expenses</h1>
        <p className="text-muted-foreground text-sm">
          What it costs to run the company is not yours to keep. Ask an administrator or accounting.
        </p>
      </div>
    );
  }

  const rows = expenses.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Operation expenses</h1>
          <p className="text-muted-foreground text-sm">
            What it costs to keep the company open — rent, utilities, insurance, registrations.
            Nothing here belongs to a trip, and no trip&rsquo;s profit is charged for it.
          </p>
        </div>
        {canWrite ? <Button onClick={() => setCreating(true)}>Record an expense</Button> : null}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full space-y-1 sm:w-44">
            <Label htmlFor="opex-month">Month</Label>
            <Input
              id="opex-month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </div>
          <div className="w-full space-y-1 sm:w-56">
            <Label htmlFor="opex-category">Category</Label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger id="opex-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All categories</SelectItem>
                {(categories.data?.items ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="opex-search">Search</Label>
            <Input
              id="opex-search"
              placeholder="Description, reference or payee"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <PeriodTotal
            month={month}
            total={summary.data?.total ?? null}
            count={summary.data?.count ?? 0}
            byCategory={summary.data?.byCategory ?? []}
          />

          {expenses.isPending ? (
            <p className="text-muted-foreground py-6 text-sm">Loading…</p>
          ) : expenses.isError ? (
            <p className="text-destructive py-6 text-sm">
              {expenses.error instanceof ApiError
                ? expenses.error.displayMessage
                : 'Could not load operation expenses.'}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground py-6 text-sm">Nothing recorded for this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Paid on</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Paid to</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  {canWrite ? <TableHead className="w-24" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((expense) => (
                  <TableRow key={expense.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(expense.spentAt)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {expense.expenseCategoryName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {expense.description ?? '—'}
                      {expense.receiptFileName ? (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs">
                          <Paperclip className="h-3 w-3" />
                          {expense.receiptFileName}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {expense.payeeName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {expense.referenceNumber ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(expense.amount)}
                    </TableCell>
                    {canWrite ? (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing(expense)}
                            aria-label={`Edit ${expense.expenseCategoryName ?? 'expense'}`}
                          >
                            Edit
                          </Button>
                          <ConfirmDeleteButton
                            label={`Remove ${expense.expenseCategoryName ?? 'expense'}`}
                            title="Remove this expense?"
                            description="It stops counting towards this period's total. The record is kept, with who removed it and when."
                            pending={remove.isPending}
                            onConfirm={() => remove.mutate(expense.id)}
                          />
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating || editing ? (
        <ExpenseDialog
          expense={editing}
          categories={categories.data?.items ?? []}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={invalidate}
        />
      ) : null}
    </div>
  );
}

/**
 * The half-open window for a `YYYY-MM` month, or no bounds at all when the
 * field is cleared.
 *
 * Both ends are built the same way the create form builds `spentAt` — a
 * date-only value read as UTC midnight — so a row recorded on the first of the
 * month and the window that is supposed to contain it are constructed by the
 * same rule rather than by two that happen to agree today.
 */
function monthWindow(month: string): { from?: string; to?: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) return {};

  const from = new Date(`${month}-01T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 1);

  return { from: from.toISOString(), to: to.toISOString() };
}

/** The period's total, and the categories it is made of. */
function PeriodTotal({
  month,
  total,
  count,
  byCategory,
}: {
  month: string;
  total: string | null;
  count: number;
  byCategory: { expenseCategoryId: string; expenseCategoryName: string | null; amount: string }[];
}) {
  return (
    <div className="bg-muted/40 flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-md border p-4">
      <div>
        <p className="text-muted-foreground text-xs">
          {month ? `Total for ${monthLabel(month)}` : 'Total, all time'}
        </p>
        <p className="text-xl font-semibold tabular-nums">
          {total === null ? '—' : formatMoney(total)}
        </p>
        <p className="text-muted-foreground text-xs">
          {count} {count === 1 ? 'expense' : 'expenses'}
        </p>
      </div>
      {/* Largest first, as the API returns it: the point of a breakdown is
          which line to look at. */}
      {byCategory.length > 0 ? (
        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {byCategory.map((row) => (
            <li key={row.expenseCategoryId}>
              {row.expenseCategoryName ?? 'Uncategorised'}{' '}
              <span className="text-foreground tabular-nums">{formatMoney(row.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00.000Z`));
}

/**
 * Recording one, and correcting one.
 *
 * ONE DIALOG FOR BOTH, because the fields are identical and two would drift —
 * the usual outcome being an edit form that quietly cannot clear a field the
 * create form could set.
 *
 * THE PAYEE REQUIREMENT IS READ FROM THE CHOSEN CATEGORY, mirroring the API
 * rather than deciding anything: `ExpenseCategory.requiresPayee` is what the
 * server enforces, and this only puts the refusal where the person can still
 * act on it. Unknown until a category is picked, and `false` then — the field
 * should not demand something before the rule that demands it has been chosen.
 */
function ExpenseDialog({
  expense,
  categories,
  onClose,
  onSaved,
}: {
  expense: OperationExpense | null;
  categories: ExpenseCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    expenseCategoryId: expense?.expenseCategoryId ?? '',
    description: expense?.description ?? '',
    amount: expense?.amount ?? '',
    spentAt: expense ? toDateInputValue(expense.spentAt) : todayInManila(),
    payeeId: expense?.payeeId ?? '',
    referenceNumber: expense?.referenceNumber ?? '',
    receiptId: expense?.receiptId ?? null,
    receiptFileName: expense?.receiptFileName ?? null,
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const payeeRequired =
    categories.find((category) => category.id === draft.expenseCategoryId)?.requiresPayee ?? false;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        expenseCategoryId: draft.expenseCategoryId,
        description: draft.description || null,
        amount: draft.amount,
        // A date-only input means midnight UTC; sent as an instant because
        // storage is UTC and the display layer renders Asia/Manila.
        spentAt: new Date(draft.spentAt).toISOString(),
        // '' is "nothing chosen"; the wire wants null.
        payeeId: draft.payeeId || null,
        referenceNumber: draft.referenceNumber || null,
        receiptId: draft.receiptId,
      };

      return expense ? updateOperationExpense(expense.id, body) : addOperationExpense(body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      // Beside the input where there is one, and in the toast either way —
      // `displayMessage` puts the field-level reason first.
      setFieldErrors(error instanceof ApiError ? error.fieldErrors : {});
      toast.error('Could not save that expense', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{expense ? 'Edit expense' : 'Record an expense'}</DialogTitle>
          <DialogDescription>
            A cost of running the company, not of a trip. It counts from the day the money left.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="opex-form-category" className="text-xs">
                Category
              </Label>
              <Select
                value={draft.expenseCategoryId}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, expenseCategoryId: value }))
                }
              >
                <SelectTrigger id="opex-form-category">
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors.expenseCategoryId ? (
                <p className="text-destructive text-xs">{fieldErrors.expenseCategoryId}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="opex-form-amount" className="text-xs">
                Amount
              </Label>
              <Input
                id="opex-form-amount"
                placeholder="0.00"
                inputMode="decimal"
                required
                value={draft.amount}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, amount: event.target.value }))
                }
              />
              {fieldErrors.amount ? (
                <p className="text-destructive text-xs">{fieldErrors.amount}</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="opex-form-spent-at" className="text-xs">
                Paid on
              </Label>
              <Input
                id="opex-form-spent-at"
                type="date"
                required
                value={draft.spentAt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, spentAt: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="opex-form-description" className="text-xs">
                Description
              </Label>
              <Input
                id="opex-form-description"
                placeholder="Optional"
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </div>
          </div>

          <div className="space-y-1">
            <PayeeField
              id="opex-form-payee"
              value={draft.payeeId}
              required={payeeRequired}
              onChange={(payeeId) => setDraft((current) => ({ ...current, payeeId }))}
            />
            {fieldErrors.payeeId ? (
              <p className="text-destructive text-xs">{fieldErrors.payeeId}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="opex-form-reference" className="text-xs">
              Reference
            </Label>
            <Input
              id="opex-form-reference"
              placeholder="Invoice or OR number (optional)"
              value={draft.referenceNumber}
              onChange={(event) =>
                setDraft((current) => ({ ...current, referenceNumber: event.target.value }))
              }
            />
          </div>

          <ReceiptField
            value={draft.receiptId}
            fileName={draft.receiptFileName}
            label="Attach invoice or receipt"
            onChange={(receiptId, fileName) =>
              setDraft((current) => ({ ...current, receiptId, receiptFileName: fileName }))
            }
          />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending || !draft.expenseCategoryId || (payeeRequired && !draft.payeeId)
              }
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {expense ? 'Save changes' : 'Record expense'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function todayInManila(): string {
  return toDateInputValue(new Date().toISOString());
}
