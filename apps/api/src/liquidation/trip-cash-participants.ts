import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mayHoldTripCashWithoutASlot } from '@eztruckr/types';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * "May this person be trusted with this trip's cash?" — asked once, here.
 *
 * THREE GUARDS ASKED IT SEPARATELY, in three copies of the same two-line
 * comparison: who may be made custodian of an account, who may be handed a
 * release, and whose pay a carried balance may be charged to. Copying a guard
 * without its reason is this codebase's recurring failure mode, and these three
 * had already drifted to three different refusal messages for one rule.
 *
 * The rule has two arms, and the second is the new one:
 *
 *   - somebody in a slot on the shipment — the driver or the helper. They are
 *     on the truck, so the cash is in their hands by definition.
 *   - AN OFFICE CASH HOLDER: a dispatch manager, which is the whole reason
 *     `staff` stopped being `crew_member`, or a dispatcher, added when the
 *     people handing cash over started carrying it themselves. Both are
 *     deliberately NOT matched against a slot: neither is assigned to a trip,
 *     they are assigned to the yard, and requiring a slot would mean inventing
 *     one on every shipment they touch.
 *
 * WHICH OFFICE ROLES COUNT is `mayHoldTripCashWithoutASlot`, asked of the
 * PERSON's `eligibleRoles` and never of the caller's session. The two are
 * different questions: a dispatcher may name a colleague custodian, and a
 * dispatcher's own login being confined to their own account is
 * `assertMayAccountForThisFloat`'s business, not this one's.
 *
 * What it is NOT is "any active staff member". An office clerk who never went
 * near the trip being made answerable for its cash is a typo, and this is the
 * layer that still catches it.
 */
export async function assertMayHoldTripCash(
  prisma: PrismaService,
  shipmentId: string,
  staffId: string,
  field: string,
  refusal: (shipmentNumber: string) => string,
): Promise<void> {
  const shipment = await prisma.client.shipment.findFirst({
    where: { id: shipmentId },
    select: { shipmentNumber: true, driverId: true, helperId: true },
  });

  if (!shipment) {
    throw new NotFoundException(`No shipment with id ${shipmentId}`);
  }

  if (shipment.driverId === staffId || shipment.helperId === staffId) {
    return;
  }

  const person = await prisma.client.staff.findFirst({
    where: { id: staffId },
    select: { eligibleRoles: true },
  });

  if (person && mayHoldTripCashWithoutASlot(person.eligibleRoles)) {
    return;
  }

  throw new BadRequestException({
    message: 'Validation failed',
    errors: [{ path: field, message: refusal(shipment.shipmentNumber ?? shipmentId) }],
  });
}
