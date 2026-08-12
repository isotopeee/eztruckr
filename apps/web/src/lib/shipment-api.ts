import type {
  AdditionalCharge,
  BillableExpense,
  Commission,
  CommissionComputation,
  CreateAdditionalChargeInput,
  CreateBillableExpenseInput,
  CreateShipmentInput,
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
  commissions: (id: string) => ['shipments', id, 'commissions'] as const,
  gasRate: (id: string) => ['shipments', id, 'gas-rate'] as const,
  ruleCoverage: ['commissions', 'rule-coverage'] as const,
};

export interface ShipmentFilters {
  page: number;
  search: string;
  status?: ShipmentStatus;
}

export interface GasRateContext {
  systemDefault: string;
  applied: string;
  isOverride: boolean;
  reason: string | null;
  frozen: boolean;
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

export function listCommissions(id: string): Promise<Commission[]> {
  return apiFetch<Commission[]>(`/shipments/${id}/commissions`);
}

export function computeCommissions(id: string): Promise<CommissionComputation> {
  return apiFetch<CommissionComputation>(`/shipments/${id}/commissions`, { method: 'POST' });
}

export function getRuleCoverage(): Promise<RuleCoverageReport> {
  return apiFetch<RuleCoverageReport>('/commissions/rule-coverage');
}
