import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "May this session see this trip's money?" — asked once, here.
 *
 * The shipments controller answers the same question inline, because it already
 * has the shipment in hand. Everything hanging off a shipment — allowances, the
 * liquidation, the settlement — needs the same answer without loading the whole
 * record, and three copies of a scoping rule is how one of them ends up subtly
 * more generous than the others.
 */
@Injectable()
export class ShipmentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "May this session see THIS ACCOUNT?" — a narrower question than the trip.
   *
   * THE TRIP GUARD IS NOT ENOUGH, and every by-id read here used to stop at it.
   * `assertMayRead` asks a crew member "did you work this trip", which is the
   * right question for the shipment and the wrong one for one person's cash:
   * a helper who worked the trip could fetch the driver's account by id and
   * read their advances, their claims, their variance and their history. The
   * LIST was filtered to own-custodianship all along, so the leak was
   * invisible from the portal and one `curl` wide — the same shape as the
   * crew-pay routes, which is why the fix is stated here rather than repeated
   * at each door.
   *
   * CREW ONLY. The office roles see every account on a trip, including the two
   * that hold floats: a dispatcher books the trip and needs to see whether the
   * driver has liquidated. What they may not do is EDIT somebody else's, and
   * that is `assertMayAccountForThisFloat`, deliberately a different list.
   *
   * Custodianship, and not the unnamed account created at booking — it is
   * nobody's until the office names one, and the portal's list has always
   * excluded it.
   */
  async assertMayReadAccount(liquidationId: string, user: RequestUser): Promise<void> {
    const liquidation = await this.prisma.client.liquidation.findFirst({
      where: { id: liquidationId },
      select: { shipmentId: true, custodianId: true },
    });

    if (!liquidation) {
      throw new NotFoundException(`No liquidation with id ${liquidationId}`);
    }

    await this.assertMayRead(liquidation.shipmentId, user);

    if (user.role !== UserRole.CREW) {
      return;
    }

    if (!user.staffId) {
      throw new ForbiddenException('This crew account is not linked to a staff member.');
    }

    if (liquidation.custodianId !== user.staffId) {
      // The same wording the write guard uses, because it is the same rule.
      throw new ForbiddenException(
        'This cash is another person’s to account for. You can only see what you were made custodian of.',
      );
    }
  }

  /**
   * The scope key for any list of rows that belong to ONE account — releases,
   * settlements. Null means "every account on the trip".
   *
   * Read from the session and never from a parameter, for the same reason the
   * shipments list overwrites its filter: there must be no query string that
   * widens it.
   */
  accountScopeFor(user: RequestUser): string | null {
    if (user.role !== UserRole.CREW) {
      return null;
    }

    if (!user.staffId) {
      throw new ForbiddenException('This crew account is not linked to a staff member.');
    }

    return user.staffId;
  }

  async assertMayRead(shipmentId: string, user: RequestUser): Promise<void> {
    const shipment = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId },
      select: { driverId: true, helperId: true },
    });

    if (!shipment) {
      throw new NotFoundException(`No shipment with id ${shipmentId}`);
    }

    if (user.role !== UserRole.CREW) {
      return;
    }

    const worked =
      user.staffId !== null &&
      (shipment.driverId === user.staffId || shipment.helperId === user.staffId);

    if (!worked) {
      // Deliberately the same shape as the shipments controller's refusal:
      // confirming a shipment exists is itself information a crew member who
      // did not work it has no claim to.
      throw new ForbiddenException('You can only view shipments you worked on.');
    }
  }
}
