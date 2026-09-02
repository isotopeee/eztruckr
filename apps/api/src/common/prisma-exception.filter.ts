import {
  BadRequestException,
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

type CaughtPrismaError =
  | Prisma.PrismaClientKnownRequestError
  | Prisma.PrismaClientValidationError
  | Prisma.PrismaClientUnknownRequestError;

/**
 * SQLSTATE 23514 is `check_violation`, and Prisma passes the Postgres message
 * through inside its own — as a Rust `Debug` rendering, so the quotes around
 * the constraint name arrive backslash-escaped. The quote is therefore matched
 * loosely (`\\?["']?`) rather than assuming one form: the escaping is an
 * implementation detail of a library's error formatting and is exactly the kind
 * of thing that changes in a patch release.
 *
 * The CODE is matched as well as the phrasing, so a message that merely
 * mentions a constraint cannot be mistaken for a violation of one.
 */
const CHECK_VIOLATION_CODE = /code: \\?["']?23514/;
const CHECK_CONSTRAINT_NAME = /violates check constraint \\?["']?([a-z0-9_]+)/;

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
@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
  // CHECK constraints arrive as UNKNOWN request errors, not known ones —
  // Prisma models unique and foreign-key violations and has no code for a
  // CHECK, so it hands the raw Postgres error through. This class was missing
  // from the list, which meant every CHECK in the schema — the thing this
  // filter's own docblock promises to translate — reached the user as a 500.
  Prisma.PrismaClientUnknownRequestError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: CaughtPrismaError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const translated = this.translate(exception);

    if (translated instanceof InternalServerErrorException) {
      this.logger.error(exception.message, exception.stack);
    }

    response.status(translated.getStatus()).json(translated.getResponse());
  }

  private translate(exception: CaughtPrismaError): HttpException {
    if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      return this.translateUnknown(exception);
    }

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

  /**
   * A CHECK violation, which in this schema is always the request's fault.
   *
   * Every CHECK here constrains values a caller supplied — an amount that must
   * be positive, a frozen flag that must be paired with the column it governs,
   * a category that must be offered somewhere. None of them can be broken by
   * the server acting on its own, so a 400 is the honest answer and a 500 is a
   * lie that reads as "the app is broken".
   *
   * THE NAME IS REPORTED RATHER THAN DECODED. Guessing at a human meaning for
   * an arbitrary constraint is exactly what this filter's docblock warns
   * against, and the names in this schema were written to be read —
   * `client_payment_amount_positive` says what it wants. Every service that can
   * reach a CHECK is expected to refuse first with a message of its own; one
   * arriving here means a path nobody guarded, so it is logged at WARN even
   * though the caller gets a 400.
   */
  private translateUnknown(exception: Prisma.PrismaClientUnknownRequestError): HttpException {
    const message = exception.message;

    if (!CHECK_VIOLATION_CODE.test(message)) {
      return new InternalServerErrorException('Database error');
    }

    const constraint = CHECK_CONSTRAINT_NAME.exec(message)?.[1];

    if (!constraint) {
      return new InternalServerErrorException('Database error');
    }

    this.logger.warn(
      `CHECK ${constraint} was reached at the database — the service above it should have refused first`,
    );

    return new BadRequestException({
      message: 'Validation failed',
      errors: [
        {
          path: '',
          message: `That combination of values is not allowed (${constraint}).`,
        },
      ],
    });
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
