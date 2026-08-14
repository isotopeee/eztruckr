import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '../generated/client';
import { ensureEnvLoaded } from './load-env';

/**
 * The database integration tests run against — a SEPARATE one from development.
 *
 * WHY IT IS SEPARATE. Suites truncate their own rows, the seed writes reference
 * data, and both used to happen inside whatever database the developer was
 * also clicking around in. A test run and a demo could not both be trusted:
 * a suite that failed halfway left fixtures behind on a screen someone was
 * looking at, and hand-made data drifted into what tests read as "seeded".
 * Development data is now the developer's, and this one is the suite's.
 *
 * `packages/db` is the only place that knows how to build it, so both vitest
 * projects can ask the same question and get the same answer.
 */

/** Resolved once. `URL` handles the password and query string for us. */
export function testDatabaseUrl(): string {
  ensureEnvLoaded();

  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) {
    return assertIsATestDatabase(explicit);
  }

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set — tests have no database to run against.',
    );
  }

  // Derive rather than require a second variable: one .env entry is one thing
  // to forget, and the derived name is the one the tooling documents anyway.
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/^\//, '').replace(/\/+$/, '')}_test`;

  return assertIsATestDatabase(url.toString());
}

/**
 * THE GUARD THAT MATTERS. Everything below this line migrates and seeds the
 * database it is pointed at, and suites then delete rows out of it. A typo in
 * `TEST_DATABASE_URL` that resolved to the development database would quietly
 * rewrite the data someone is working with — so the name has to say `_test`
 * out loud, and there is no flag to skip this.
 */
function assertIsATestDatabase(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '');

  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to use "${name}" as the test database: the name must end in "_test". ` +
        'Tests migrate, seed and delete rows in whatever they are pointed at.',
    );
  }

  return url;
}

/** `packages/db`, from either `src/` (tsx) or `dist/` (compiled). */
const packageRoot = path.resolve(__dirname, '..');

function run(command: string, args: string[], databaseUrl: string): void {
  execFileSync(path.join(packageRoot, 'node_modules', '.bin', command), args, {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

/**
 * An arbitrary but fixed key. Advisory locks are per-database, and this one is
 * always taken against the maintenance database, so every caller queues on the
 * same lock however many test projects there are.
 */
const SETUP_LOCK_KEY = 40212026;

/** The always-present database to hold the lock on, since ours may not exist. */
function maintenanceUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}

/**
 * Bring the test database up to date, from nothing if need be.
 *
 * `migrate deploy` creates the database when it is missing, so a fresh checkout
 * needs no setup step — and `deploy` rather than `dev` because it never prompts
 * and never invents a migration from drift.
 *
 * THE SEED RUNS HERE, and that is the point of the split: it is no longer
 * development data, it is the suites' fixture. Every DB-backed test reads
 * `admin@eztruckr.ph`, the FUEL category and the seeded staff, so the fixture
 * has to exist before the first suite opens a connection. Development is left
 * empty on purpose and is initialised through the app instead.
 *
 * WHY THE ADVISORY LOCK. Turbo runs `@eztruckr/db#test` and `@eztruckr/api#test`
 * in PARALLEL, and each vitest project calls this from its own globalSetup — so
 * on a machine where the test database does not exist yet, two processes race
 * to create and seed it. `prisma migrate deploy` takes its own lock and
 * survives that; the seed does not, and both processes insert the same
 * administrator, one of them hitting the unique index on email. That is not
 * hypothetical — it is what happened the first time the whole volume was
 * recreated, and it only ever fails on a cold database, which is exactly when
 * nobody is expecting it.
 *
 * Holding the lock across both steps makes the second caller wait and then find
 * everything already done, because the seed is idempotent.
 */
export async function prepareTestDatabase(): Promise<string> {
  const url = testDatabaseUrl();
  const lockHolder = new PrismaClient({ datasources: { db: { url: maintenanceUrl(url) } } });

  try {
    await lockHolder.$executeRawUnsafe(`SELECT pg_advisory_lock(${SETUP_LOCK_KEY})`);

    try {
      run('prisma', ['migrate', 'deploy'], url);
      run('tsx', ['prisma/seed.ts'], url);
    } catch (error) {
      // execFileSync puts the child's output on the error, not the console, so
      // without this the failure reads as a bare non-zero exit code.
      const detail = error as { stdout?: Buffer; stderr?: Buffer };
      const output = [detail.stdout?.toString(), detail.stderr?.toString()]
        .filter(Boolean)
        .join('\n')
        .trim();

      throw new Error(`Could not prepare the test database (${url}):\n${output || String(error)}`);
    } finally {
      await lockHolder.$executeRawUnsafe(`SELECT pg_advisory_unlock(${SETUP_LOCK_KEY})`);
    }
  } finally {
    await lockHolder.$disconnect();
  }

  return url;
}
