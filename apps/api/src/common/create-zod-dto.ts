import type { ZodType, output } from 'zod';

export interface ZodDtoStatic<TSchema extends ZodType = ZodType> {
  new (): output<TSchema>;
  readonly zodSchema: TSchema;
}

/**
 * Turn a shared Zod schema from `@eztruckr/types` into a class Nest can use as
 * a DTO type, so validation rules live in exactly one place and are shared
 * with the web app.
 *
 * Usage:
 *   class CreateShipmentDto extends createZodDto(createShipmentSchema) {}
 *   @Post() create(@Body() dto: CreateShipmentDto) { ... }
 *
 * `ZodValidationPipe` picks up the attached schema automatically.
 */
export function createZodDto<TSchema extends ZodType>(schema: TSchema): ZodDtoStatic<TSchema> {
  class ZodDto {
    static readonly zodSchema = schema;
  }

  return ZodDto as unknown as ZodDtoStatic<TSchema>;
}

/** Narrowing guard used by the pipe. */
export function isZodDto(metatype: unknown): metatype is ZodDtoStatic {
  return (
    typeof metatype === 'function' &&
    'zodSchema' in metatype &&
    typeof (metatype as ZodDtoStatic).zodSchema?.safeParse === 'function'
  );
}
