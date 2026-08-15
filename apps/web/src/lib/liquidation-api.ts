import type {
  Allowance,
  AllowanceSummary,
  CarrySettlementToPayoutInput,
  CreateLiquidationInput,
  CreateLiquidationLineInput,
  IssueAllowanceInput,
  Liquidation,
  LiquidationLine,
  OutstandingAllowanceReport,
  Receipt,
  RecordSettlementInput,
  SetCustodianInput,
  SetLiquidationReferenceInput,
  Settlement,
} from '@eztruckr/types';
import { apiFetch, apiUpload, queryString, receiptContentUrl } from './api-client';

/**
 * The cash trail of a trip: what went out, what it was spent on, what came back.
 *
 * ADDRESSED BY ACCOUNT, NOT BY TRIP. Everything below that concerns one
 * custodian's money — lines, the four moves, the settlement — takes a
 * `liquidationId`, and only the two lists and the create take a `shipmentId`.
 * These all hung off `/shipments/:id/liquidation` while a trip could hold one
 * account; that path stopped identifying anything the moment a driver and a
 * helper could each be holding cash, because it named the trip and the actions
 * are about a person.
 *
 * As with the shipment API, note the absence of arithmetic. `totalAdvanced`,
 * `totalLiquidated`, `variance` and `recognisedCost` all arrive computed. The
 * variance in particular is a figure somebody may be asked to hand cash over
 * against, so it is derived in exactly one place and it is not here.
 */

export const liquidationKeys = {
  all: ['liquidation'] as const,
  allowances: (shipmentId: string) => ['liquidation', shipmentId, 'allowances'] as const,
  /** Plural: every custodian's account on the trip. */
  liquidations: (shipmentId: string) => ['liquidation', shipmentId, 'liquidations'] as const,
  settlements: (shipmentId: string) => ['liquidation', shipmentId, 'settlements'] as const,
  list: (filter: string) => ['liquidation', 'list', filter] as const,
  outstanding: ['liquidation', 'outstanding'] as const,
};

// --- allowances ------------------------------------------------------------

export function getAllowances(shipmentId: string): Promise<AllowanceSummary> {
  return apiFetch<AllowanceSummary>(`/shipments/${shipmentId}/allowances`);
}

/**
 * Still posted to the trip, because that is what a release is against — but the
 * body now names the account it is booked to, which is what moves a variance.
 */
export function issueAllowance(shipmentId: string, input: IssueAllowanceInput): Promise<Allowance> {
  return apiFetch<Allowance>(`/shipments/${shipmentId}/allowances`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeAllowance(shipmentId: string, id: string): Promise<void> {
  return apiFetch<void>(`/shipments/${shipmentId}/allowances/${id}`, { method: 'DELETE' });
}

// --- the accounts on a trip ------------------------------------------------

export function listShipmentLiquidations(shipmentId: string): Promise<Liquidation[]> {
  return apiFetch<Liquidation[]>(`/shipments/${shipmentId}/liquidations`);
}

/** Opening an account for a second cash holder. The custodian is required. */
export function createLiquidation(
  shipmentId: string,
  input: CreateLiquidationInput,
): Promise<Liquidation> {
  return apiFetch<Liquidation>(`/shipments/${shipmentId}/liquidations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function setLiquidationCustodian(
  liquidationId: string,
  input: SetCustodianInput,
): Promise<Liquidation> {
  return apiFetch<Liquidation>(`/liquidations/${liquidationId}/custodian`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/**
 * The voucher number this account was settled under. Its own call rather than
 * part of the submission, because the paperwork does not always arrive at the
 * same moment the claims do — see `setLiquidationReferenceSchema`.
 */
export function setLiquidationReference(
  liquidationId: string,
  input: SetLiquidationReferenceInput,
): Promise<Liquidation> {
  return apiFetch<Liquidation>(`/liquidations/${liquidationId}/reference`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** Only while the account is empty — the API refuses one holding money. */
export function removeLiquidation(liquidationId: string): Promise<void> {
  return apiFetch<void>(`/liquidations/${liquidationId}`, { method: 'DELETE' });
}

export function listLiquidations(filter: {
  returnedOnly?: boolean;
  status?: number;
}): Promise<Liquidation[]> {
  return apiFetch<Liquidation[]>(
    `/liquidations${queryString({ returnedOnly: filter.returnedOnly, status: filter.status })}`,
  );
}

// --- lines -----------------------------------------------------------------

export function addLiquidationLine(
  liquidationId: string,
  input: CreateLiquidationLineInput,
): Promise<LiquidationLine> {
  return apiFetch<LiquidationLine>(`/liquidations/${liquidationId}/lines`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeLiquidationLine(liquidationId: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/liquidations/${liquidationId}/lines/${lineId}`, {
    method: 'DELETE',
  });
}

// --- the four moves --------------------------------------------------------

/** Each mirrors an endpoint rather than a status write, and each moves ONE account. */
export function submitLiquidation(liquidationId: string, remarks: string | null) {
  return apiFetch<Liquidation>(`/liquidations/${liquidationId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ remarks }),
  });
}

export function returnLiquidation(liquidationId: string, reason: string) {
  return apiFetch<Liquidation>(`/liquidations/${liquidationId}/return`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function approveLiquidation(liquidationId: string, remarks: string | null) {
  return apiFetch<Liquidation>(`/liquidations/${liquidationId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ remarks }),
  });
}

export function reverseLiquidation(liquidationId: string, reason: string) {
  return apiFetch<Liquidation>(`/liquidations/${liquidationId}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// --- settlement ------------------------------------------------------------

/**
 * Every account's settlement on one trip, in one request.
 *
 * The per-account `GET /liquidations/:id/settlement` exists too, but a screen
 * showing the trip wants them together — and asking per account would be one
 * request per custodian to render a single card.
 */
export function listSettlements(shipmentId: string): Promise<Settlement[]> {
  return apiFetch<Settlement[]>(`/shipments/${shipmentId}/settlements`);
}

export function recordSettlement(
  liquidationId: string,
  input: RecordSettlementInput,
): Promise<Settlement> {
  return apiFetch<Settlement>(`/liquidations/${liquidationId}/settlement/record`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function carrySettlementToPayout(
  liquidationId: string,
  input: CarrySettlementToPayoutInput,
): Promise<Settlement> {
  return apiFetch<Settlement>(`/liquidations/${liquidationId}/settlement/carry-to-payout`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getOutstandingAllowances(): Promise<OutstandingAllowanceReport> {
  return apiFetch<OutstandingAllowanceReport>('/settlements/outstanding');
}

// --- receipts --------------------------------------------------------------

export function uploadReceipt(file: File): Promise<Receipt> {
  const form = new FormData();
  form.append('file', file);

  return apiUpload<Receipt>('/receipts', form);
}

export { receiptContentUrl };
