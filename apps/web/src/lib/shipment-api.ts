import type {
  AdditionalCharge,
  Adjustment,
  BillableExpense,
  ClientPayment,
  ClientPaymentListQuery,
  ClientPaymentSummary,
  UpdateClientPaymentInput,
  Commission,
  CommissionComputation,
  CreateAdjustmentInput,
  CrewPayLine,
  CompanyPaidExpense,
  CreateAdditionalChargeInput,
  CreateBillableExpenseInput,
  CreateCompanyPaidExpenseInput,
  CreateShipmentInput,
  GasRateContext,
  GrossProfit,
  Page,
  RecordClientPaymentInput,
  RuleCoverageReport,
  Shipment,
  ShipmentSortField,
  ShipmentStatus,
  SortDirection,
  UpdateRateChainInput,
  UpdateShipmentInput,
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
  /** What the client has paid, and what is still outstanding. */
  payments: (id: string) => ['shipments', id, 'payments'] as const,
  /** Accounting's queue across every trip, keyed by the status it is showing. */
  paymentQueue: (status: number) => ['shipments', 'payments', 'queue', status] as const,
  grossProfit: (id: string) => ['shipments', id, 'gross-profit'] as const,
  commissions: (id: string) => ['shipments', id, 'commissions'] as const,
  crewPay: (id: string) => ['shipments', id, 'crew-pay'] as const,
  gasRate: (id: string) => ['shipments', id, 'gas-rate'] as const,
  ruleCoverage: ['commissions', 'rule-coverage'] as const,
};

export interface ShipmentFilters {
  page: number;
  search: string;
  status?: ShipmentStatus;
  /** Ordering, applied by the API — the list is paginated, so it has to be. */
  sort: ShipmentSortField;
  direction: SortDirection;
}

export function listShipments(filters: ShipmentFilters): Promise<Page<Shipment>> {
  return apiFetch<Page<Shipment>>(
    `/shipments${queryString({
      page: filters.page,
      search: filters.search,
      status: filters.status,
      sort: filters.sort,
      direction: filters.direction,
    })}`,
  );
}

export function getShipment(id: string): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}`);
}

export function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  return apiFetch<Shipment>('/shipments', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Correcting the trip's own details: client, date, route, lane, container.
 *
 * The same endpoint as the DRAFT booking edit, because both halves are
 * `CAN_WRITE_SHIPMENTS` — what differs is WHEN each field closes, and the
 * service decides that from the body. Send only the fields above once a trip
 * has left DRAFT; the rate chain and the cargo are refused there, and have
 * `updateRateChain` and the truck endpoint respectively.
 */
export function updateShipment(id: string, input: UpdateShipmentInput): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/**
 * Correcting the gross rate or the broker cut after booking.
 *
 * Its own endpoint rather than `PATCH /shipments/:id`, and the difference is
 * who and when: the booking edit is every dispatcher's and closes at DRAFT,
 * this belongs to the administrator and the dispatch manager and stays open
 * until a commission has been paid. See `updateRateChainSchema`.
 */
export function updateRateChain(id: string, input: UpdateRateChainInput): Promise<Shipment> {
  return apiFetch<Shipment>(`/shipments/${id}/rate-chain`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
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

/**
 * Money received from the client for this trip.
 *
 * `amountDue`, `balance` and the payment status all arrive computed, like every
 * other figure here. The balance in particular is what somebody quotes to a
 * client down the phone, so it is derived on the server — from the same
 * function that answers what the trip is worth in the P&L — and never by
 * subtracting two strings in a component.
 */
export function getClientPayments(id: string): Promise<ClientPaymentSummary> {
  return apiFetch<ClientPaymentSummary>(`/shipments/${id}/payments`);
}

export function recordClientPayment(
  id: string,
  input: RecordClientPaymentInput,
): Promise<ClientPayment> {
  return apiFetch<ClientPayment>(`/shipments/${id}/payments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Correcting one.
 *
 * THE OTHER HALF OF "RETURN FOR CORRECTION", and without it that decision is a
 * dead end: accounting hands a payment back saying the date is wrong and the
 * person who recorded it has nowhere to fix it. The server decides what the
 * edit does to the verification state — a recorder's edit puts the row back in
 * accounting's queue and clears the note it was answering, an accountant's
 * re-stamps it — so nothing here has to know that rule.
 */
export function updateClientPayment(
  id: string,
  paymentId: string,
  input: UpdateClientPaymentInput,
): Promise<ClientPayment> {
  return apiFetch<ClientPayment>(`/shipments/${id}/payments/${paymentId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** A refund or a bounced check: the removal of a receipt that did not happen. */
export function removeClientPayment(id: string, paymentId: string): Promise<void> {
  return apiFetch<void>(`/shipments/${id}/payments/${paymentId}`, { method: 'DELETE' });
}

/**
 * Accounting's side: what is waiting to be checked, and the two answers.
 *
 * ADDRESSED BY THE PAYMENT'S OWN ID rather than through the trip, because
 * accounting works a queue across trips and the shipment is incidental to the
 * decision — the same split the allowance request endpoints make.
 */
export function listClientPaymentQueue(query: ClientPaymentListQuery): Promise<ClientPayment[]> {
  return apiFetch<ClientPayment[]>(
    `/client-payments${queryString({ verificationStatus: query.verificationStatus })}`,
  );
}

/** Confirming one matches the bank. No payload: see `verifyClientPaymentSchema`. */
export function verifyClientPayment(paymentId: string): Promise<ClientPayment> {
  return apiFetch<ClientPayment>(`/client-payments/${paymentId}/verify`, { method: 'POST' });
}

/** Handing one back for correction, with the reason that makes it actionable. */
export function returnClientPaymentForCorrection(
  paymentId: string,
  reason: string,
): Promise<ClientPayment> {
  return apiFetch<ClientPayment>(`/client-payments/${paymentId}/return`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
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

/**
 * What each crew member is actually owed: commission plus adjustments, added
 * up by the API. The net is NOT computed here — nothing under `src/` does
 * money arithmetic, which is why this endpoint exists at all.
 */
export function getCrewPay(id: string): Promise<CrewPayLine[]> {
  return apiFetch<CrewPayLine[]>(`/shipments/${id}/crew-pay`);
}

export function addAdjustment(input: CreateAdjustmentInput): Promise<Adjustment> {
  return apiFetch<Adjustment>('/adjustments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeAdjustment(id: string): Promise<void> {
  return apiFetch<void>(`/adjustments/${id}`, { method: 'DELETE' });
}

export function getRuleCoverage(): Promise<RuleCoverageReport> {
  return apiFetch<RuleCoverageReport>('/commissions/rule-coverage');
}
