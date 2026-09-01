import { withDeleted, type ExtendedPrismaClient } from '@eztruckr/db';
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
 * Idempotent by lookup rather than by catching the unique violation: a caught
 * constraint error inside a transaction has already poisoned it, and this runs
 * inside the delivery write. There is no retry here for the same reason, and
 * none is owed — the race this leaves is two callers delivering one shipment in
 * the same instant, which is what the lookup and the index between them already
 * refuse rather than duplicate.
 *
 * THE NUMBER IS ALLOCATED THE SAME WAY `LiquidationService` allocates it —
 * max + 1 over the trip's accounts INCLUDING soft-deleted ones. Usually that is
 * 1, because this is the trip's first account; it is not 1 when every account on
 * a trip has been removed and this backstop runs again, and handing that trip a
 * second "account 1" would give one number to two piles of cash.
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

  const latest = await withDeleted(async () =>
    tx.liquidation.findFirst({
      where: { shipmentId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    }),
  );

  const created = await tx.liquidation.create({
    data: { shipmentId, sequence: (latest?.sequence ?? 0) + 1, status: LiquidationStatus.PENDING },
    select: { id: true },
  });

  return created.id;
}
