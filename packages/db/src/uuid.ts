/**
 * UUIDv7, for the few places an id has to exist before the row does.
 *
 * EVERY TABLE DEFAULTS ITS PRIMARY KEY TO POSTGRES 18's BUILT-IN `uuidv7()`,
 * so application code almost never needs this: Prisma omits the column and the
 * database fills it. It exists for the callers that cannot work that way —
 * Better Auth, which generates ids in JavaScript before handing rows to its
 * adapter, and test fixtures that need to know an id in advance.
 *
 * WHY v7 AND NOT v4. A v7 is time-ordered in its first 48 bits, so inserts land
 * at the right-hand edge of the primary key's B-tree instead of scattering
 * across it, and `ORDER BY id` is `ORDER BY created`. That matters here because
 * every table is append-mostly and soft-deleted, so the index only ever grows.
 * The trade is that a row's id reveals roughly when it was made, which is
 * already true of `createdAt` sitting beside it.
 *
 * Hand-written rather than added as a dependency, for the same reason the exact
 * arithmetic in `apps/api/src/commission/rational.ts` is: the specification is
 * short, the implementation is testable, and this project has added no
 * dependency since Phase 3.
 *
 * Layout, from RFC 9562:
 *
 *   0                   1                   2                   3
 *   |  unix_ts_ms (48 bits)         | ver |  rand_a  | var |  rand_b  |
 *   bytes 0-5: milliseconds since the epoch, big-endian
 *   byte  6:   high nibble = 7 (version), low nibble random
 *   byte  8:   top two bits = 10 (variant), rest random
 *   the remainder: random
 */

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Milliseconds do not fit in 32 bits, so the top two bytes are taken by
  // division rather than by shifting — `>>` would coerce to int32 and silently
  // wrap in 2038.
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ms / 0x100000000) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return format(bytes);
}

/**
 * A DETERMINISTIC v7-shaped uuid, for test fixtures.
 *
 * Integration tests share one database and each suite deletes its own rows by
 * matching a prefix — a strategy that needed rescuing when primary keys stopped
 * being free-form strings. `block` reserves the first 32 bits for one suite, so
 * `WHERE id::text LIKE '<block>-%'` still selects exactly that suite's rows and
 * two suites running concurrently cannot delete each other's fixtures.
 *
 * The name is hashed into the tail so a fixture keeps the same id across runs,
 * which is what makes the cleanup-then-recreate cycle in `beforeEach` work.
 *
 * NOT for production data: the timestamp bits are fixed, so these sort together
 * and ahead of everything real. That is deliberate — a fixture id should be
 * obvious on sight.
 */
export function testUuid(block: string, name: string): string {
  if (!/^[0-9a-f]{8}$/.test(block)) {
    throw new Error(`Test uuid block must be 8 hex digits, got "${block}"`);
  }

  // FNV-1a, 64 bits, spread over the 12 hex digits of the final group.
  let hash = 0xcbf29ce484222325n;
  for (const code of Buffer.from(name, 'utf8')) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(code)) * 0x100000001b3n);
  }

  const tail = hash.toString(16).padStart(16, '0').slice(-12);

  return `${block}-0000-7000-8000-${tail}`;
}

function format(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += '-';
    out += HEX[bytes[index]!];
  }
  return out;
}
