import {
  assignCrewSchema,
  assignTruckSchema,
  createAdditionalChargeSchema,
  createBillableExpenseSchema,
  createShipmentSchema,
  setGasRateOverrideSchema,
  shipmentListQuerySchema,
  transitionShipmentSchema,
  updateAdditionalChargeSchema,
  updateBillableExpenseSchema,
  updateShipmentSchema,
} from '@eztruckr/types';
import { z } from 'zod';
import { createZodDto } from '../common/create-zod-dto';

/**
 * Nest-visible handles on schemas that already live in `@eztruckr/types`, so
 * the web form and the API enforce the same rules. The global
 * ZodValidationPipe strips undeclared fields, which is what stops a request
 * body ever supplying `status`, `netRate` or any audit column — every one of
 * those is computed or stamped by the server.
 */

export class ShipmentListQueryDto extends createZodDto(shipmentListQuerySchema) {}
export class CreateShipmentDto extends createZodDto(createShipmentSchema) {}
export class UpdateShipmentDto extends createZodDto(updateShipmentSchema) {}
export class AssignCrewDto extends createZodDto(assignCrewSchema) {}
export class AssignTruckDto extends createZodDto(assignTruckSchema) {}
export class TransitionShipmentDto extends createZodDto(transitionShipmentSchema) {}
export class SetGasRateOverrideDto extends createZodDto(setGasRateOverrideSchema) {}

export class CreateBillableExpenseDto extends createZodDto(createBillableExpenseSchema) {}
export class UpdateBillableExpenseDto extends createZodDto(updateBillableExpenseSchema) {}
export class CreateAdditionalChargeDto extends createZodDto(createAdditionalChargeSchema) {}
export class UpdateAdditionalChargeDto extends createZodDto(updateAdditionalChargeSchema) {}

/** Horizon for the proactive rule-coverage check, in days. */
export const ruleCoverageQuerySchema = z.object({
  horizonDays: z.coerce.number().int().min(1).max(365).default(30),
});

export class RuleCoverageQueryDto extends createZodDto(ruleCoverageQuerySchema) {}
