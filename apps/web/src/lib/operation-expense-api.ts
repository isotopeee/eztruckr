import type {
  CreateOperationExpenseInput,
  OperationExpense,
  OperationExpenseSummary,
  Page,
  UpdateOperationExpenseInput,
} from '@eztruckr/types';
import { apiFetch, queryString } from './api-client';

/**
 * The company's own running costs.
 *
 * ITS OWN FILE, not `shipment-api.ts`, for the same reason the API module is
 * its own: nothing here takes a shipment id. Adding it there would have made
 * the one file every trip screen imports the home of a record that has no trip.
 *
 * Note what is absent, as everywhere else in `lib/`: arithmetic. The period
 * total and its per-category breakdown arrive computed. The web app formats.
 */

export interface OperationExpenseFilters {
  /** Inclusive lower bound on `spentAt`, as an ISO instant. */
  from?: string;
  /** EXCLUSIVE upper bound. The API's window is half-open; see its schema. */
  to?: string;
  expenseCategoryId?: string;
  search?: string;
}

export const operationExpenseKeys = {
  all: ['operation-expenses'] as const,
  list: (filters: OperationExpenseFilters) => ['operation-expenses', 'list', filters] as const,
  summary: (filters: OperationExpenseFilters) =>
    ['operation-expenses', 'summary', filters] as const,
};

export function listOperationExpenses(
  filters: OperationExpenseFilters,
): Promise<Page<OperationExpense>> {
  return apiFetch<Page<OperationExpense>>(
    `/operation-expenses${queryString({ ...toParams(filters), pageSize: 100 })}`,
  );
}

export function summariseOperationExpenses(
  filters: OperationExpenseFilters,
): Promise<OperationExpenseSummary> {
  return apiFetch<OperationExpenseSummary>(
    `/operation-expenses/summary${queryString(toParams(filters))}`,
  );
}

/**
 * The filters as a plain bag for `queryString`, which takes an index signature
 * an interface deliberately does not have. Spelled out field by field rather
 * than cast, so adding a filter to the interface and forgetting to send it is a
 * change somebody makes on purpose.
 */
function toParams(filters: OperationExpenseFilters): Record<string, string | undefined> {
  return {
    from: filters.from,
    to: filters.to,
    expenseCategoryId: filters.expenseCategoryId,
    search: filters.search,
  };
}

export function addOperationExpense(input: CreateOperationExpenseInput): Promise<OperationExpense> {
  return apiFetch<OperationExpense>('/operation-expenses', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateOperationExpense(
  id: string,
  input: UpdateOperationExpenseInput,
): Promise<OperationExpense> {
  return apiFetch<OperationExpense>(`/operation-expenses/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function removeOperationExpense(id: string): Promise<void> {
  return apiFetch<void>(`/operation-expenses/${id}`, { method: 'DELETE' });
}
