import {
  approveLiquidationSchema,
  carrySettlementToPayoutSchema,
  createLiquidationLineSchema,
  issueAllowanceSchema,
  liquidationListQuerySchema,
  recordSettlementSchema,
  returnLiquidationSchema,
  reverseLiquidationSchema,
  submitLiquidationSchema,
  updateAllowanceSchema,
  updateLiquidationLineSchema,
} from '@eztruckr/types';
import { createZodDto } from '../common/create-zod-dto';

/**
 * Nest-visible handles on schemas that already live in `@eztruckr/types`, so a
 * web form and the API enforce the same rules. The global ZodValidationPipe
 * strips undeclared fields, which is what stops a request body supplying
 * `status`, `variance`, `approvedBy` or any audit column — every one of those
 * is computed or stamped by the server.
 */

export class IssueAllowanceDto extends createZodDto(issueAllowanceSchema) {}
export class UpdateAllowanceDto extends createZodDto(updateAllowanceSchema) {}

export class LiquidationListQueryDto extends createZodDto(liquidationListQuerySchema) {}
export class CreateLiquidationLineDto extends createZodDto(createLiquidationLineSchema) {}
export class UpdateLiquidationLineDto extends createZodDto(updateLiquidationLineSchema) {}

export class SubmitLiquidationDto extends createZodDto(submitLiquidationSchema) {}
export class ReturnLiquidationDto extends createZodDto(returnLiquidationSchema) {}
export class ApproveLiquidationDto extends createZodDto(approveLiquidationSchema) {}
export class ReverseLiquidationDto extends createZodDto(reverseLiquidationSchema) {}

export class RecordSettlementDto extends createZodDto(recordSettlementSchema) {}
export class CarrySettlementToPayoutDto extends createZodDto(carrySettlementToPayoutSchema) {}
