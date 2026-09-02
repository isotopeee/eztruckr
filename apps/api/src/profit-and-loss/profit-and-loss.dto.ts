import { profitAndLossQuerySchema } from '@eztruckr/types';
import { createZodDto } from '../common/create-zod-dto';

/**
 * A Nest-visible handle on the schema in `@eztruckr/types`, so the screen and
 * the API agree on what a period is. The global ZodValidationPipe strips
 * undeclared fields, which is what stops a caller inventing a filter this
 * report deliberately does not offer — see the note on
 * `profitAndLossQuerySchema` about why there is no `clientId`.
 */
export class ProfitAndLossQueryDto extends createZodDto(profitAndLossQuerySchema) {}
