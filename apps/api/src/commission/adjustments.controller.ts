import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole, type Adjustment } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import { CAN_READ_SHIPMENTS, CAN_WRITE_SHIPMENT_MONEY } from '../auth/role-policy';
import { AdjustmentsService } from './adjustments.service';
import {
  AdjustmentListQueryDto,
  CreateAdjustmentDto,
  UpdateAdjustmentDto,
} from './adjustments.dto';

/**
 * Increases and decreases to crew pay.
 *
 * ONE RESOURCE, FILTERED — not `/shipments/:id/adjustments` and
 * `/staff/:id/adjustments` as two paths to the same rows. An adjustment
 * belongs to a crew member and OPTIONALLY to a trip, so a nested path would
 * have no home for the standing case and would invite a second service to
 * grow behind it.
 *
 * WRITES ARE ACCOUNTING'S — `CAN_WRITE_SHIPMENT_MONEY`, the same list as
 * charges, the gas override and the liquidation decisions. Operations moves
 * trucks; changing what somebody is paid is not that.
 *
 * CREW MAY READ THEIR OWN, and that is deliberate rather than incidental. A
 * deduction a crew member cannot see is a deduction they will find out about
 * from a short payout, which is the worst possible moment. The filter is
 * OVERWRITTEN from the session, so there is no query string a portal login can
 * send to see somebody else's.
 */
@Controller('adjustments')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Get()
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  list(
    @Query() query: AdjustmentListQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Adjustment[]> {
    return this.adjustments.list(this.scopeToCaller(query, user));
  }

  @Post()
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  create(@Body() dto: CreateAdjustmentDto, @CurrentUser() user: RequestUser): Promise<Adjustment> {
    // The approver is the caller. See the service for why it is not in the DTO.
    return this.adjustments.create(dto, user.id);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  update(@Param('id') id: string, @Body() dto: UpdateAdjustmentDto): Promise<Adjustment> {
    return this.adjustments.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  remove(@Param('id') id: string): Promise<{ removed: true }> {
    return this.adjustments.remove(id);
  }

  // -------------------------------------------------------------------------

  private scopeToCaller(query: AdjustmentListQueryDto, user: RequestUser): AdjustmentListQueryDto {
    if (user.role !== UserRole.CREW) {
      return query;
    }

    if (!user.staffId) {
      // A crew login with no crew member is a broken account, not an
      // unfiltered one. Refusing beats returning everybody's pay changes.
      throw new ForbiddenException('This crew account is not linked to a crew member.');
    }

    return { ...query, staffId: user.staffId };
  }
}
