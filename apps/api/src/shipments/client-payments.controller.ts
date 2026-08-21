import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { ClientPayment, ClientPaymentSummary } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_SHIPMENTS, CAN_WRITE_SHIPMENT_MONEY } from '../auth/role-policy';
import { ClientPaymentsService } from './client-payments.service';
import { RecordClientPaymentDto, UpdateClientPaymentDto } from './shipments.dto';

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
 * WRITING IS `CAN_WRITE_SHIPMENT_MONEY` — accounting and the administrator, the
 * same list that records a charge and releases cash. It is reused rather than
 * given a list of its own because the question is identical: this decides
 * money, and dispatch owns movement. Both dispatch roles stay out, which here
 * is a job description rather than the control it is on the disbursement side.
 *
 * CREW SEE NONE OF IT. They are absent from the read list, so the route is a
 * 403 rather than a redacted response — what the company charges its client is
 * not something a crew member's session has any claim to, and the shipment
 * detail already blanks the rate chain for the same reason.
 */
@Controller('shipments/:shipmentId/payments')
export class ClientPaymentsController {
  constructor(private readonly payments: ClientPaymentsService) {}

  @Get()
  @Roles(...CAN_READ_SHIPMENTS)
  summary(@Param('shipmentId') shipmentId: string): Promise<ClientPaymentSummary> {
    return this.payments.summary(shipmentId);
  }

  @Post()
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  record(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: RecordClientPaymentDto,
  ): Promise<ClientPayment> {
    return this.payments.record(shipmentId, dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  update(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateClientPaymentDto,
  ): Promise<ClientPayment> {
    return this.payments.update(shipmentId, id, dto);
  }

  /**
   * Reversing a payment — a refund, or a check that bounced.
   *
   * A soft delete rather than a negative row: it records who reversed it and
   * when, beside the amount and the reference that were originally entered.
   */
  @Delete(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  remove(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
  ): Promise<{ removed: true }> {
    return this.payments.remove(shipmentId, id);
  }
}
