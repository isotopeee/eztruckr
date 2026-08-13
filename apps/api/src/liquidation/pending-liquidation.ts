import type { ExtendedPrismaClient } from '@eztruckr/db';
import { LiquidationStatus } from '@eztruckr/types';

/**
 * The bit of the liquidation lifecycle that the SHIPMENT owns.
 *
 * A liquidation comes into existence when the trip is BOOKED, not when somebody
 * first opens a form. It began as "when the trip is marked delivered", which
 * was already an improvement on the absence of a row — no query can filter on
 * a missing row, no dashboard can count it, no crew portal can show it — but
 * delivery is the end of the trip, not the start of the paperwork. A crew
 * spending money on the road on day one had nowhere to record it until the
 * office got round to closing the trip out.
 *
 * WHY A FUNCTION AND NOT A SERVICE METHOD. `ShipmentsService` needs to do this
 * inside the same statement that creates the shipment, and `LiquidationService`
 * needs `ShipmentsService` for everything it does. Injecting both ways is a
 * dependency cycle for the sake of one create; a plain function over the
 * transaction client is the same code with none of the ceremony.
 *
 * Takes the transaction client so the liquidation and the shipment land
 * together. A shipment with no liquidation row is precisely the state this
 * exists to make impossible — and it is still called on delivery, as a backstop
 * for every trip booked before creation started doing it.
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
