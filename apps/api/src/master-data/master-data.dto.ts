import {
  createClientSchema,
  createCommissionRuleSchema,
  createStaffSchema,
  createExpenseCategorySchema,
  createRouteSchema,
  createThirdPartySchema,
  createTruckSchema,
  masterDataListQuerySchema,
  updateClientSchema,
  updateCommissionRuleSchema,
  updateStaffSchema,
  updateExpenseCategorySchema,
  updateRouteSchema,
  updateThirdPartySchema,
  updateTruckSchema,
} from '@eztruckr/types';
import { createZodDto } from '../common/create-zod-dto';

/**
 * DTO classes for the master data controllers.
 *
 * Each is nothing but a Nest-visible handle on a schema that already lives in
 * `@eztruckr/types`, so the web app validates a form against the very same
 * rules the API enforces. The global `ZodValidationPipe` strips anything the
 * schema does not declare, which is what stops a request body ever supplying
 * `createdBy`, `deletedAt` or `id`.
 */

export class ListQueryDto extends createZodDto(masterDataListQuerySchema) {}

export class CreateTruckDto extends createZodDto(createTruckSchema) {}
export class UpdateTruckDto extends createZodDto(updateTruckSchema) {}

export class CreateStaffDto extends createZodDto(createStaffSchema) {}
export class UpdateStaffDto extends createZodDto(updateStaffSchema) {}

export class CreateClientDto extends createZodDto(createClientSchema) {}
export class UpdateClientDto extends createZodDto(updateClientSchema) {}

export class CreateThirdPartyDto extends createZodDto(createThirdPartySchema) {}
export class UpdateThirdPartyDto extends createZodDto(updateThirdPartySchema) {}

export class CreateRouteDto extends createZodDto(createRouteSchema) {}
export class UpdateRouteDto extends createZodDto(updateRouteSchema) {}

export class CreateExpenseCategoryDto extends createZodDto(createExpenseCategorySchema) {}
export class UpdateExpenseCategoryDto extends createZodDto(updateExpenseCategorySchema) {}

export class CreateCommissionRuleDto extends createZodDto(createCommissionRuleSchema) {}
export class UpdateCommissionRuleDto extends createZodDto(updateCommissionRuleSchema) {}
