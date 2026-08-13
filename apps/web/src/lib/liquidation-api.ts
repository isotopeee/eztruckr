import type {
  Allowance,
  AllowanceSummary,
  CarrySettlementToPayoutInput,
  CreateLiquidationLineInput,
  IssueAllowanceInput,
  Liquidation,
  LiquidationLine,
  OutstandingAllowanceReport,
  Receipt,
  RecordSettlementInput,
  Settlement,
} from '@eztruckr/types';
import { apiFetch, apiUpload, queryString, receiptContentUrl } from './api-client';

/**
 * The cash trail of a trip: what went out, what it was spent on, what came back.
 *
 * As with the shipment API, note the absence of arithmetic. `totalAdvanced`,
 * `totalLiquidated`, `variance` and `recognisedCost` all arrive computed. The
 * variance in particular is a figure somebody may be asked to hand cash over
 * against, so it is derived in exactly one place and it is not here.
 */

export const liquidationKeys = {
  all: ['liquidation'] as const,
  allowances: (shipmentId: string) => ['liquidation', shipmentId, 'allowances'] as const,
  liquidation: (shipmentId: string) => ['liquidation', shipmentId, 'liquidation'] as const,
  settlement: (shipmentId: string) => ['liquidation', shipmentId, 'settlement'] as const,
  list: (filter: string) => ['liquidation', 'list', filter] as const,
  outstanding: ['liquidation', 'outstanding'] as const,
};

// --- allowances ------------------------------------------------------------

export function getAllowances(shipmentId: string): Promise<AllowanceSummary> {
  return apiFetch<AllowanceSummary>(`/shipments/${shipmentId}/allowances`);
}

export function issueAllowance(shipmentId: string, input: IssueAllowanceInput): Promise<Allowance> {
  return apiFetch<Allowance>(`/shipments/${shipmentId}/allowances`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeAllowance(shipmentId: string, id: string): Promise<void> {
  return apiFetch<void>(`/shipments/${shipmentId}/allowances/${id}`, { method: 'DELETE' });
}

// --- liquidation -----------------------------------------------------------

export function getLiquidation(shipmentId: string): Promise<Liquidation> {
  return apiFetch<Liquidation>(`/shipments/${shipmentId}/liquidation`);
}

export function listLiquidations(filter: {
  returnedOnly?: boolean;
  status?: number;
}): Promise<Liquidation[]> {
  return apiFetch<Liquidation[]>(
    `/liquidations${queryString({ returnedOnly: filter.returnedOnly, status: filter.status })}`,
  );
}

export function addLiquidationLine(
  shipmentId: string,
  input: CreateLiquidationLineInput,
): Promise<LiquidationLine> {
  return apiFetch<LiquidationLine>(`/shipments/${shipmentId}/liquidation/lines`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeLiquidationLine(shipmentId: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/shipments/${shipmentId}/liquidation/lines/${lineId}`, {
    method: 'DELETE',
  });
}

/** The four named moves, each mirroring an endpoint rather than a status write. */
export function submitLiquidation(shipmentId: string, remarks: string | null) {
  return apiFetch<Liquidation>(`/shipments/${shipmentId}/liquidation/submit`, {
    method: 'POST',
    body: JSON.stringify({ remarks }),
  });
}

export function returnLiquidation(shipmentId: string, reason: string) {
  return apiFetch<Liquidation>(`/shipments/${shipmentId}/liquidation/return`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function approveLiquidation(shipmentId: string, remarks: string | null) {
  return apiFetch<Liquidation>(`/shipments/${shipmentId}/liquidation/approve`, {
    method: 'POST',
    body: JSON.stringify({ remarks }),
  });
}

export function reverseLiquidation(shipmentId: string, reason: string) {
  return apiFetch<Liquidation>(`/shipments/${shipmentId}/liquidation/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// --- settlement ------------------------------------------------------------

export function getSettlement(shipmentId: string): Promise<Settlement> {
  return apiFetch<Settlement>(`/shipments/${shipmentId}/settlement`);
}

export function recordSettlement(
  shipmentId: string,
  input: RecordSettlementInput,
): Promise<Settlement> {
  return apiFetch<Settlement>(`/shipments/${shipmentId}/settlement/record`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function carrySettlementToPayout(
  shipmentId: string,
  input: CarrySettlementToPayoutInput,
): Promise<Settlement> {
  return apiFetch<Settlement>(`/shipments/${shipmentId}/settlement/carry-to-payout`, {
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
