import {
  createOperationExpenseSchema,
  operationExpenseListQuerySchema,
  operationExpenseSummaryQuerySchema,
  updateOperationExpenseSchema,
} from '@eztruckr/types';
import { createZodDto } from '../common/create-zod-dto';

/**
 * Nest-visible handles on schemas that already live in `@eztruckr/types`, so
 * the web form and the API enforce the same rules. The global
 * ZodValidationPipe strips undeclared fields, which is what stops a request
 * body ever supplying `payeeRequired` — the one column here that is resolved by
 * the server and frozen onto the row.
 */
export class OperationExpenseListQueryDto extends createZodDto(operationExpenseListQuerySchema) {}
export class OperationExpenseSummaryQueryDto extends createZodDto(
  operationExpenseSummaryQuerySchema,
) {}
export class CreateOperationExpenseDto extends createZodDto(createOperationExpenseSchema) {}
export class UpdateOperationExpenseDto extends createZodDto(updateOperationExpenseSchema) {}
