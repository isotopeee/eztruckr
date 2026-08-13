import type {
  AdditionalCharge,
  BillableExpense,
  Commission,
  CommissionComputation,
  CompanyPaidExpense,
  CreateAdditionalChargeInput,
  CreateBillableExpenseInput,
  CreateCompanyPaidExpenseInput,
  CreateShipmentInput,
  GasRateContext,
  GrossProfit,
  Page,
  RuleCoverageReport,
  Shipment,
  ShipmentStatus,
} from '@eztruckr/types';
import { apiFetch, queryString } from './api-client';

/**
 * Shipment data access.
 *
 * Note what is absent: any arithmetic. Every peso figure rendered by the
 * shipment screens arrives already computed from the API — the rate chain, the
 * commission base, each crew commission. The web app formats and displays; it
 * never derives. That is why there is no `currency.js` import anywhere under
 * `src/`.
 */

export const shipmentKeys = {
  all: ['shipments'] as const,
  list: (filters: ShipmentFilters) => ['shipments', 'list', filters] as const,
  detail: (id: string) => ['shipments', id] as const,
  billableExpenses: (id: string) => ['shipments', id, 'billable-expenses'] as const,
  additionalCharges: (id: string) => ['shipments', id, 'additional-charges'] as const,
  companyExpenses: (id: string) => ['shipments', id, 'company-expenses'] as const,
  grossProfit: (id: string) => ['shipments', id, 'gross-profit'] as const,
  commissions: (id: string) => ['shipments', id, 'commissions'] as const,
  gasRate: (id: string) => ['shipments', id, 'gas-rate'] as const,
  ruleCoverage: ['commissions', 'rule-coverage'] as const,
};

export interface ShipmentFilters {
  page: number;
  search: string;
  status?: ShipmentStatus;
}

export function listShipments(filters: ShipmentFilters): Promise<Page<Shipment>> {
  return apiFetch<Page<Shipment>>(
    `/shipments${queryString({
      page: filters.page,
      search: filters.search,
      status: filters.status,
    })}`,
  );
}

export function getShipment(id: string): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}`);
}

export function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  return apiFetch<Shipment>('/shipments', { method: 'POST', body: JSON.stringify(input) });
}

export function assignCrew(
  id: string,
  input: { driverId: string | null; helperId: string | null },
): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}/crew`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/**
 * Its own call, not part of `assignCrew` — the truck is a separate decision and
 * stays changeable later than the crew do. See `assignTruckSchema`.
 */
export function assignTruck(id: string, truckId: string | null): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}/truck`, {
    method: 'PATCH',
    body: JSON.stringify({ truckId }),
  });
}

export function transitionShipment(id: string, to: ShipmentStatus): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ to }),
  });
}

export function getGasRate(id: string): Promise<GasRateContext> {
  return apiFetch<GasRateContext>(`/shipments/${id}/gas-rate`);
}

export function setGasRate(
  id: string,
  input: { rate: string | null; reason: string | null },
): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}/gas-rate`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listBillableExpenses(id: string): Promise<BillableExpense[]> {
  return apiFetch<BillableExpense[]>(`/shipments/${id}/billable-expenses`);
}

export function addBillableExpense(
  id: string,
  input: CreateBillableExpenseInput,
): Promise<BillableExpense> {
  return apiFetch<BillableExpense>(`/shipments/${id}/billable-expenses`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeBillableExpense(id: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/shipments/${id}/billable-expenses/${lineId}`, { method: 'DELETE' });
}

export function listAdditionalCharges(id: string): Promise<AdditionalCharge[]> {
  return apiFetch<AdditionalCharge[]>(`/shipments/${id}/additional-charges`);
}

export function addAdditionalCharge(
  id: string,
  input: CreateAdditionalChargeInput,
): Promise<AdditionalCharge> {
  return apiFetch<AdditionalCharge>(`/shipments/${id}/additional-charges`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeAdditionalCharge(id: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/shipments/${id}/additional-charges/${lineId}`, { method: 'DELETE' });
}

/**
 * Costs the company settled itself. Separate endpoints from the charges above,
 * because they are the other side of the P&L and stay editable later — see
 * `CompanyPaidExpensesService`.
 */
export function listCompanyPaidExpenses(id: string): Promise<CompanyPaidExpense[]> {
  return apiFetch<CompanyPaidExpense[]>(`/shipments/${id}/company-expenses`);
}

export function addCompanyPaidExpense(
  id: string,
  input: CreateCompanyPaidExpenseInput,
): Promise<CompanyPaidExpense> {
  return apiFetch<CompanyPaidExpense>(`/shipments/${id}/company-expenses`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeCompanyPaidExpense(id: string, expenseId: string): Promise<void> {
  return apiFetch<void>(`/shipments/${id}/company-expenses/${expenseId}`, { method: 'DELETE' });
}

export function getGrossProfit(id: string): Promise<GrossProfit> {
  return apiFetch<GrossProfit>(`/shipments/${id}/gross-profit`);
}

export function listCommissions(id: string): Promise<Commission[]> {
  return apiFetch<Commission[]>(`/shipments/${id}/commissions`);
}

export function computeCommissions(id: string): Promise<CommissionComputation> {
  return apiFetch<CommissionComputation>(`/shipments/${id}/commissions`, { method: 'POST' });
}

export function getRuleCoverage(): Promise<RuleCoverageReport> {
  return apiFetch<RuleCoverageReport>('/commissions/rule-coverage');
}
