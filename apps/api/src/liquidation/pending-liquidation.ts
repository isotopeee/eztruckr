import { withDeleted, type ExtendedPrismaClient } from '@eztruckr/db';
import { LiquidationStatus } from '@eztruckr/types';

/**
 * The bit of the liquidation lifecycle that the SHIPMENT owns.
 *
 * AN ACCOUNT ARRIVES WITH A PERSON, not with a trip. Booking used to open one
 * with nobody named to it — the reasoning being that a crew spends money from
 * day one and needs somewhere to record it, which is true — but what that
 * produced was an account with no custodian on every trip in the system,
 * including the ones nobody ever held cash for. Releases landed on it because
 * it was the default, which is how a helper's ferry money reached the row that
 * later became the driver's: the blending the per-custodian split exists to
 * prevent, reintroduced by the default.
 *
 * So the two functions below are asymmetric on purpose.
 * `ensureAccountForCustodian` is the ordinary path and always names somebody.
 * `ensurePendingLiquidation` opens an UNNAMED one and is called from exactly
 * one place — delivery — for the trip that arrives there with no accounts at
 * all: at that moment the crew are holding receipts, and a row somebody can be
 * named to beats having nowhere to file them.
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
 * An unnamed PENDING account for a delivered trip that has none — and nothing
 * at all for one that already has any.
 *
 * ANY account, not a matching one: a trip whose only account belongs to the
 * helper is a trip where somebody has been thinking about its cash, and adding
 * an unnamed row beside theirs would put a default back on the screen for
 * releases to drift onto.
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
 * 1; it is not when every account on a trip has been removed and this runs
 * again, and handing that trip a second "account 1" would give one number to
 * two piles of cash.
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
    data: {
      shipmentId,
      sequence: await nextSequence(tx, shipmentId),
      status: LiquidationStatus.PENDING,
    },
    select: { id: true },
  });

  return created.id;
}

/**
 * The account a named crew member gets the moment they are put on the trip.
 *
 * WHY THE HELPER NEEDS ONE AT ALL. The trip's own account is created at
 * booking with nobody named to it, and in practice it becomes the driver's — so
 * a helper who was handed ferry money at the pier had nowhere to record it
 * until somebody in the office noticed and opened an account by hand. What
 * actually happened then is that the spending went onto the driver's account,
 * because that was the only row on the screen, and the two people's cash was
 * blended again in the one place the schema was rebuilt to keep apart.
 *
 * ENSURE, NOT OPEN, and the distinction is the whole of the idempotency here.
 * `assignCrew` writes both slots on every call, so re-saving a form with an
 * unchanged helper reaches this again, and a trip can now legitimately carry
 * several accounts for one person — nothing downstream would refuse a duplicate
 * the way it once did. A person who already holds a live account on this trip
 * keeps it and gets no second one; a SECOND account for the same person stays
 * what it should be, something the office asks for deliberately.
 *
 * IT NEVER CLOSES ONE. Swapping the helper leaves the outgoing person's account
 * exactly where it is: it may hold releases, claims, a settlement — cash that
 * moved and cannot be un-moved by an edit to a slot. Removing an account that
 * turns out to be empty is a separate, explicit act.
 */
export async function ensureAccountForCustodian(
  tx: PendingLiquidationClient,
  shipmentId: string,
  custodianId: string,
): Promise<string> {
  const existing = await tx.liquidation.findFirst({
    where: { shipmentId, custodianId },
    select: { id: true },
  });

  if (existing) {
    return existing.id;
  }

  const created = await tx.liquidation.create({
    data: {
      shipmentId,
      sequence: await nextSequence(tx, shipmentId),
      custodianId,
      status: LiquidationStatus.PENDING,
    },
    select: { id: true },
  });

  return created.id;
}

/**
 * Max + 1 over the trip's accounts, soft-deleted ones included.
 *
 * ONE COPY for both callers above. `LiquidationService.nextSequence` is the
 * third and cannot share this one — it runs outside a transaction and retries
 * on collision — but two copies inside this file would be the version of this
 * that eventually numbers from the live rows only and hands a removed account's
 * number to a new pile of cash.
 */
async function nextSequence(tx: PendingLiquidationClient, shipmentId: string): Promise<number> {
  const latest = await withDeleted(async () =>
    tx.liquidation.findFirst({
      where: { shipmentId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    }),
  );

  return (latest?.sequence ?? 0) + 1;
}
