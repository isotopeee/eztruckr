import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import type { AllowanceRequest } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_DECIDE_ALLOWANCE_REQUEST,
  CAN_READ_SHIPMENTS,
  CAN_REQUEST_ALLOWANCE,
} from '../auth/role-policy';
import { AllowanceRequestsService } from './allowance-requests.service';
import {
  AllowanceRequestListQueryDto,
  ApproveAllowanceRequestDto,
  CreateAllowanceRequestDto,
  DeclineAllowanceRequestDto,
} from './liquidation.dto';
import { ShipmentAccessService } from './shipment-access.service';

/**
 * Dispatch asking for a trip's cash, and accounting answering.
 *
 * BOTH SHAPES OF ROUTE, in one controller because there are five endpoints and
 * splitting them would put the ask and its answer in different files. Raising
 * and withdrawing hang off the SHIPMENT, because that is what the cash is for
 * and the trip is the screen you are looking at. Deciding is addressed by the
 * REQUEST'S OWN ID, because accounting works a queue across trips and the
 * shipment is incidental to the decision.
 *
 * TWO NAMED DECISIONS rather than one `PATCH /status`, following the
 * liquidation lifecycle for the same reason: the payloads differ. An approval
 * carries how the money moved and what proves it; a decline carries a reason and
 * nothing else. One endpoint would have to accept both and then work out, from
 * a status it was also given, which half was mandatory.
 *
 * CREW SEE NONE OF THIS. They may read their own releases, because a release is
 * cash they were handed; a request is an office conversation about money that
 * has not moved, and the read list is `CAN_READ_SHIPMENTS` accordingly.
 */
@Controller()
export class AllowanceRequestsController {
  constructor(
    private readonly requests: AllowanceRequestsService,
    private readonly access: ShipmentAccessService,
  ) {}

  // --- the queue, across trips ---------------------------------------------

  /**
   * What is waiting, at one status.
   *
   * The dashboard reads this at PENDING — accounting sees work to do and
   * dispatch sees what they are waiting on, which is the same list read from two
   * sides and deliberately not two endpoints.
   */
  @Get('allowance-requests')
  @Roles(...CAN_READ_SHIPMENTS)
  list(@Query() query: AllowanceRequestListQueryDto): Promise<AllowanceRequest[]> {
    return this.requests.list(query);
  }

  // --- through the trip ----------------------------------------------------

  @Get('shipments/:shipmentId/allowance-requests')
  @Roles(...CAN_READ_SHIPMENTS)
  async listForShipment(
    @Param('shipmentId') shipmentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<AllowanceRequest[]> {
    await this.access.assertMayRead(shipmentId, user);

    return this.requests.listForShipment(shipmentId);
  }

  @Post('shipments/:shipmentId/allowance-requests')
  @Roles(...CAN_REQUEST_ALLOWANCE)
  create(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateAllowanceRequestDto,
    @CurrentUser() user: RequestUser,
  ): Promise<AllowanceRequest> {
    return this.requests.create(shipmentId, dto, user);
  }

  /**
   * Withdrawing an ask nobody has answered yet.
   *
   * The requester's own list, not accounting's: calling off a request is
   * dispatch saying they no longer need the money, and accounting's way of
   * disposing of one is to decline it with a reason.
   */
  @Delete('shipments/:shipmentId/allowance-requests/:id')
  @Roles(...CAN_REQUEST_ALLOWANCE)
  withdraw(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
  ): Promise<{ removed: true }> {
    return this.requests.withdraw(shipmentId, id);
  }

  // --- the decision --------------------------------------------------------

  @Post('allowance-requests/:id/approve')
  @Roles(...CAN_DECIDE_ALLOWANCE_REQUEST)
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveAllowanceRequestDto,
    @CurrentUser() user: RequestUser,
  ): Promise<AllowanceRequest> {
    return this.requests.approve(id, dto, user);
  }

  @Post('allowance-requests/:id/decline')
  @Roles(...CAN_DECIDE_ALLOWANCE_REQUEST)
  decline(
    @Param('id') id: string,
    @Body() dto: DeclineAllowanceRequestDto,
    @CurrentUser() user: RequestUser,
  ): Promise<AllowanceRequest> {
    return this.requests.decline(id, dto, user);
  }
}
