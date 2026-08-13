import type { ExtendedPrismaClient } from '@eztruckr/db';
import { LiquidationStatus } from '@eztruckr/types';

/**
 * The bit of the liquidation lifecycle that the SHIPMENT owns.
 *
 * A liquidation comes into existence when a trip is marked delivered, not when
 * somebody first opens a form. Before this existed, "the crew still owe us
 * paperwork" was the absence of a row — which no query can filter on, no
 * dashboard can count, and no crew portal can show.
 *
 * WHY A FUNCTION AND NOT A SERVICE METHOD. `ShipmentsService` needs to do this
 * inside the same statement that records delivery, and `LiquidationService`
 * needs `ShipmentsService` for everything it does. Injecting both ways is a
 * dependency cycle for the sake of one create; a plain function over the
 * transaction client is the same code with none of the ceremony.
 *
 * Takes the transaction client so the liquidation and the status change land
 * together. A delivered shipment with no liquidation row is precisely the state
 * this exists to make impossible.
 */
export type PendingLiquidationClient = Pick<ExtendedPrismaClient, 'liquidation'>;

/**
 * Creates the shipment's PENDING liquidation, unless a live one already exists.
 *
 * Idempotent by lookup rather than by catching the partial unique violation: a
 * caught constraint error inside a transaction has already poisoned it, and
 * this runs inside the delivery write.
 */
export async function ensurePendingLiquidation(
  tx: PendingLiquidationClient,
  shipmentId: string,
): Promise<string> {
  const existing = await tx.liquidation.findFirst({
    where: { shipmentId },
    select: { id: true },
  });

  if (existing) {
    return existing.id;
  }

  const created = await tx.liquidation.create({
    data: { shipmentId, status: LiquidationStatus.PENDING },
    select: { id: true },
  });

  return created.id;
}
