import { prepareTestDatabase } from './src/test-database';

/**
 * Migrate and seed the test database once, before any suite connects.
 *
 * Runs in its own process, so the URL it returns cannot be handed to the
 * workers from here — `vitest.config.ts` puts it in `test.env` instead. Both
 * call `testDatabaseUrl()`, so there is one answer and no way for setup and
 * suites to disagree about which database they mean.
 */
export async function setup(): Promise<void> {
  await prepareTestDatabase();
}
