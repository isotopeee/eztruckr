import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { roleRequiresStaffLink, type Liquidation } from '@eztruckr/types';
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
   *
   * SCOPED FOR EVERY LINKED ROLE, not just CREW. This list is a WORK QUEUE —
   * the portal renders it under "liquidations waiting on you" — and the only
   * people it can be waiting on are the ones who may act on it. The two office
   * cash holders still READ widely: they see every trip through `/shipments`
   * and every account on one through `/shipments/:id/liquidations`. But they
   * may edit only accounts they are custodian of and may decide none at all, so
   * accounting's queue is not theirs, and handing it to them under that heading
   * would be the same defect the crew scope already had — a list that disagrees
   * with the guard behind it.
   *
   * The two lists are separately declared and happen to agree: a role is linked
   * to a staff row because it holds cash, and holds cash means confined to its
   * own. `ROLES_CONFINED_TO_THEIR_OWN_FLOAT` is the one the guard consults, and
   * if the two ever part company this should follow that one.
   */
  private scopeToCaller(user: RequestUser): string | null {
    if (!roleRequiresStaffLink(user.role)) {
      return null;
    }

    if (!user.staffId) {
      // A linked login with no staff member is a broken account, not an
      // unfiltered one. Refusing beats returning every liquidation.
      throw new ForbiddenException('This account is not linked to a staff member.');
    }

    return user.staffId;
  }
}
