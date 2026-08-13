import {
  adjustmentListQuerySchema,
  createAdjustmentSchema,
  updateAdjustmentSchema,
} from '@eztruckr/types';
import { createZodDto } from '../common/create-zod-dto';

/**
 * `approvedBy` is deliberately absent from every one of these. It is taken from
 * the session, so no request body can claim an authorisation that did not
 * happen — the validation pipe strips undeclared fields, which is what makes
 * leaving it out an enforcement rather than an omission.
 */
export class AdjustmentListQueryDto extends createZodDto(adjustmentListQuerySchema) {}
export class CreateAdjustmentDto extends createZodDto(createAdjustmentSchema) {}
export class UpdateAdjustmentDto extends createZodDto(updateAdjustmentSchema) {}
