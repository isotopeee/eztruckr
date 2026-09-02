import { Prisma } from '@eztruckr/db';
import { describe, expect, it, vi } from 'vitest';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * A CHECK violation is a 400, not a 500.
 *
 * WHAT THIS PINS. The filter's docblock has always promised to translate CHECK
 * constraints, and it never did: Prisma models unique and foreign-key
 * violations with codes of its own and has NO code for a CHECK, so it raises a
 * `PrismaClientUnknownRequestError` carrying the raw Postgres error — a class
 * the `@Catch` list did not name. Every CHECK in the schema therefore reached
 * the user as "Internal server error", which reads as a broken app for what is
 * always a bad request.
 *
 * THE MESSAGE BELOW IS VERBATIM from a real 23514 raised by unticking both
 * `offeredOn` flags on an expense category, escaping and all. The escaping is
 * the fragile part — it is Rust `Debug` output from inside a library — so it is
 * captured here rather than described, and a Prisma upgrade that changes it
 * fails this test instead of quietly restoring the 500s.
 */

const CHECK_VIOLATION_MESSAGE = `
Error occurred during query execution:
ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"expense_category\\" violates check constraint \\"expense_category_offered_somewhere\\"", severity: "ERROR", detail: Some("Failing row contains (...)."), column: None, hint: None }), transient: false })`;

/** Enough of an `ArgumentsHost` for the filter to answer into. */
function hostCapturing(): {
  host: Parameters<PrismaExceptionFilter['catch']>[1];
  status: () => number | undefined;
  body: () => unknown;
} {
  let status: number | undefined;
  let body: unknown;

  const response = {
    status: (code: number) => {
      status = code;
      return response;
    },
    json: (payload: unknown) => {
      body = payload;
      return response;
    },
  };

  return {
    host: {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as Parameters<PrismaExceptionFilter['catch']>[1],
    status: () => status,
    body: () => body,
  };
}

const unknownError = (message: string) =>
  new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' });

describe('a CHECK violation', () => {
  it('answers 400 and names the constraint', () => {
    const filter = new PrismaExceptionFilter();
    vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);

    const { host, status, body } = hostCapturing();
    filter.catch(unknownError(CHECK_VIOLATION_MESSAGE), host);

    expect(status()).toBe(400);
    expect(body()).toEqual({
      message: 'Validation failed',
      errors: [
        {
          path: '',
          message:
            'That combination of values is not allowed (expense_category_offered_somewhere).',
        },
      ],
    });
  });

  /**
   * Reaching a CHECK means a path nobody guarded — the service above it was
   * supposed to refuse with a message of its own. The caller still gets a 400,
   * but it must not pass silently.
   */
  it('warns, so an unguarded path is visible in the logs', () => {
    const filter = new PrismaExceptionFilter();
    const warn = vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);

    filter.catch(unknownError(CHECK_VIOLATION_MESSAGE), hostCapturing().host);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('expense_category_offered_somewhere'),
    );
  });
});

describe('an unknown error that is NOT a CHECK violation', () => {
  /**
   * The line this filter's docblock draws, and it still holds: guessing at a
   * database error is how a genuine fault is reported as a validation message
   * and never investigated. Only 23514 is translated.
   */
  it('stays a 500 rather than being guessed at', () => {
    const filter = new PrismaExceptionFilter();
    vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);

    const { host, status } = hostCapturing();
    filter.catch(unknownError('Connection reset by peer'), host);

    expect(status()).toBe(500);
  });

  it('is not fooled by a message that merely mentions a constraint', () => {
    const filter = new PrismaExceptionFilter();
    vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);

    const { host, status } = hostCapturing();
    filter.catch(
      unknownError('could not create check constraint "some_future_rule": disk full'),
      host,
    );

    expect(status()).toBe(500);
  });
});

describe('the known codes are untouched', () => {
  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });

  it('still reports a unique violation as a conflict', () => {
    const { host, status } = hostCapturing();
    new PrismaExceptionFilter().catch(known('P2002'), host);

    expect(status()).toBe(409);
  });

  it('still reports a malformed uuid as a 404', () => {
    const { host, status } = hostCapturing();
    new PrismaExceptionFilter().catch(known('P2023'), host);

    expect(status()).toBe(404);
  });
});

describe('an InternalServerErrorException is what the filter logs at error', () => {
  it('keeps the existing default path', () => {
    const filter = new PrismaExceptionFilter();
    const error = vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);

    const { host, status } = hostCapturing();
    filter.catch(
      new Prisma.PrismaClientKnownRequestError('boom', { code: 'P9999', clientVersion: 'test' }),
      host,
    );

    expect(status()).toBe(500);
    expect(error).toHaveBeenCalled();
  });
});
