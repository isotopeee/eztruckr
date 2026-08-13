import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { UserRole, type Liquidation } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import { CAN_READ_SHIPMENTS, CAN_SUBMIT_LIQUIDATION } from '../auth/role-policy';
import { LiquidationListQueryDto } from './liquidation.dto';
import { LiquidationService } from './liquidation.service';

/**
 * Liquidations across every shipment: accounting's queue, and the crew's own
 * list of what is waiting on them.
 *
 * Separate from the per-shipment controller because the question is different —
 * "what needs attention" rather than "what happened on this trip" — and because
 * this is where crew scoping has to be applied, from the session.
 */
@Controller('liquidations')
export class LiquidationsController {
  constructor(private readonly liquidations: LiquidationService) {}

  @Get()
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_SUBMIT_LIQUIDATION)
  list(
    @Query() query: LiquidationListQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation[]> {
    return this.liquidations.list(query, this.scopeToCaller(user));
  }

  /**
   * The scope key, from the session and nowhere else. Returning null for an
   * office role is what makes the same endpoint serve both audiences without a
   * query parameter that could be forged.
   */
  private scopeToCaller(user: RequestUser): string | null {
    if (user.role !== UserRole.CREW) {
      return null;
    }

    if (!user.crewMemberId) {
      // A crew login with no crew member is a broken account, not an
      // unfiltered one. Refusing beats returning every liquidation.
      throw new ForbiddenException('This crew account is not linked to a crew member.');
    }

    return user.crewMemberId;
  }
}
