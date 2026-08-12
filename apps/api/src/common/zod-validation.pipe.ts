import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { isZodDto } from './create-zod-dto';

/**
 * Global validation pipe.
 *
 * Anything typed with a `createZodDto(...)` class is parsed and, critically,
 * STRIPPED to the schema's own shape — so fields a client should not be able
 * to set (createdBy, updatedBy, computed money columns) never reach a service
 * even if they are present in the request body.
 *
 * Parameters without a Zod DTO type pass through untouched.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;

    if (!isZodDto(metatype)) {
      return value;
    }

    const result = metatype.zodSchema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data;
  }
}
