import {
  Catch,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { Prisma } from '@eztruckr/db';
import type { Response } from 'express';

/**
 * Turns the database's own guarantees into honest HTTP answers.
 *
 * This schema pushes a lot of correctness down into Postgres — partial unique
 * indexes, CHECK constraints, ON DELETE RESTRICT, the payout triggers. Without
 * this filter every one of those surfaces as a 500, which reads to a user as
 * "the app is broken" when the truth is "that plate number is already in use".
 *
 * Only the codes with an unambiguous meaning are translated. Anything else
 * stays a 500, because guessing at a database error is how a genuine fault
 * gets reported as a validation message and never investigated.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const translated = this.translate(exception);

    if (translated instanceof InternalServerErrorException) {
      this.logger.error(exception.message, exception.stack);
    }

    response.status(translated.getStatus()).json(translated.getResponse());
  }

  private translate(
    exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError,
  ): HttpException {
    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
      return new InternalServerErrorException('Invalid database query');
    }

    switch (exception.code) {
      case 'P2002':
        return new ConflictException({
          message: 'Another record already uses that value',
          fields: this.targetFields(exception),
        });

      case 'P2003':
        // Reached only if a reference probe missed something: ON DELETE
        // RESTRICT caught what the application should have caught first.
        return new ConflictException(
          'That record is still referred to by other records and cannot be removed',
        );

      case 'P2025':
        return new NotFoundException('Record not found');

      case 'P2023':
        /**
         * "Inconsistent column data" — in this schema, always a value that
         * cannot be a `uuid`.
         *
         * Primary keys are `uuid` rather than text, so an id of the wrong shape
         * no longer matches nothing; it fails the cast. Request BODIES never
         * reach here, because `idSchema` refuses them with a field-level 400
         * first. What does reach here is a PATH PARAMETER — `/payees/banana` —
         * which no pipe validates.
         *
         * 404 rather than 400, and deliberately the same answer as an id that
         * is well-formed and absent: both mean "no such record", and
         * distinguishing them would tell an unauthenticated prober which of
         * their guesses were at least shaped like real ids.
         */
        return new NotFoundException('Record not found');

      default:
        return new InternalServerErrorException('Database error');
    }
  }

  /** P2002 reports the offending columns in `meta.target`, when it can. */
  private targetFields(exception: Prisma.PrismaClientKnownRequestError): string[] {
    const target = exception.meta?.target;

    if (Array.isArray(target)) {
      return target.filter((field): field is string => typeof field === 'string');
    }

    return typeof target === 'string' ? [target] : [];
  }
}
