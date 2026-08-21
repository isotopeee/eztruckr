import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ClientPayment, ClientPaymentSummary } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_READ_SHIPMENTS,
  CAN_RECORD_CLIENT_PAYMENT,
  CAN_VERIFY_CLIENT_PAYMENT,
} from '../auth/role-policy';
import { ClientPaymentsService } from './client-payments.service';
import {
  ClientPaymentListQueryDto,
  ReturnClientPaymentDto,
  RecordClientPaymentDto,
  UpdateClientPaymentDto,
} from './shipments.dto';

/**
 * What the client has paid for a trip.
 *
 * ADDRESSED THROUGH THE SHIPMENT, like every other money row that hangs off
 * one, and every handler checks the payment belongs to the shipment named in
 * the URL — which is what stops one trip's record governing another trip's
 * money.
 *
 * THERE IS NO "SET THE AMOUNT PAID" ENDPOINT and there never will be. A second
 * payment is a POST that adds a row, because money received twice arrived
 * twice. The GET returns every payment plus what is still outstanding, and that
 * balance is computed on the server: nothing under the web app's `src/` does
 * money arithmetic.
 *
 * RECORDING AND CHECKING ARE TWO DIFFERENT LISTS, and that split is the whole
 * point. `CAN_RECORD_CLIENT_PAYMENT` includes the dispatch manager, because the
 * person who moved the freight is routinely the first to hear the client paid
 * for it; `CAN_VERIFY_CLIENT_PAYMENT` is accounting's alone, because confirming
 * it against the bank statement has to be somebody else. A role in both would
 * make the second state mean nothing.
 *
 * THE DECISIONS ARE ADDRESSED BY THE PAYMENT'S OWN ID, not through the trip,
 * for the same reason an allowance request's are: accounting works a queue
 * across trips and the shipment is incidental to the decision. Recording still
 * hangs off the shipment, because that is what the money is for and the trip is
 * the screen you are looking at.
 *
 * CREW SEE NONE OF IT. They are absent from the read list, so the route is a
 * 403 rather than a redacted response — what the company charges its client is
 * not something a crew member's session has any claim to, and the shipment
 * detail already blanks the rate chain for the same reason.
 */
@Controller()
export class ClientPaymentsController {
  constructor(private readonly payments: ClientPaymentsService) {}

  // --- the queue, across trips ---------------------------------------------

  /**
   * What is waiting, at one status.
   *
   * The dashboard reads this at UNVERIFIED — accounting sees work to do and the
   * dispatch manager sees what they are waiting on, which is the same list
   * read from two sides and deliberately not two endpoints.
   */
  @Get('client-payments')
  @Roles(...CAN_READ_SHIPMENTS)
  list(@Query() query: ClientPaymentListQueryDto): Promise<ClientPayment[]> {
    return this.payments.list(query);
  }

  // --- the decision --------------------------------------------------------

  @Post('client-payments/:id/verify')
  @Roles(...CAN_VERIFY_CLIENT_PAYMENT)
  verify(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<ClientPayment> {
    return this.payments.verify(id, user);
  }

  /**
   * Handing one back for correction, with a required reason.
   *
   * `POST :id/return`, matching `POST /liquidations/:id/return` — the same act,
   * the same required reason, and deliberately the same word for it.
   */
  @Post('client-payments/:id/return')
  @Roles(...CAN_VERIFY_CLIENT_PAYMENT)
  returnForCorrection(
    @Param('id') id: string,
    @Body() dto: ReturnClientPaymentDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ClientPayment> {
    return this.payments.returnForCorrection(id, dto, user);
  }

  // --- through the trip ----------------------------------------------------

  @Get('shipments/:shipmentId/payments')
  @Roles(...CAN_READ_SHIPMENTS)
  summary(@Param('shipmentId') shipmentId: string): Promise<ClientPaymentSummary> {
    return this.payments.summary(shipmentId);
  }

  @Post('shipments/:shipmentId/payments')
  @Roles(...CAN_RECORD_CLIENT_PAYMENT)
  record(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: RecordClientPaymentDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ClientPayment> {
    return this.payments.record(shipmentId, dto, user);
  }

  @Patch('shipments/:shipmentId/payments/:id')
  @Roles(...CAN_RECORD_CLIENT_PAYMENT)
  update(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateClientPaymentDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ClientPayment> {
    return this.payments.update(shipmentId, id, dto, user);
  }

  /**
   * Reversing a payment — a refund, or a check that bounced.
   *
   * A soft delete rather than a negative row: it records who reversed it and
   * when, beside the amount and the reference that were originally entered.
   *
   * A VERIFIED payment is refused to whoever cannot verify one — the service
   * decides that, because the guard can only see the role and not the row.
   */
  @Delete('shipments/:shipmentId/payments/:id')
  @Roles(...CAN_RECORD_CLIENT_PAYMENT)
  remove(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ removed: true }> {
    return this.payments.remove(shipmentId, id, user);
  }
}
