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
      user.crewMemberId !== null &&
      (shipment.driverId === user.crewMemberId || shipment.helperId === user.crewMemberId);

    if (!worked) {
      // Deliberately the same shape as the shipments controller's refusal:
      // confirming a shipment exists is itself information a crew member who
      // did not work it has no claim to.
      throw new ForbiddenException('You can only view shipments you worked on.');
    }
  }
}
