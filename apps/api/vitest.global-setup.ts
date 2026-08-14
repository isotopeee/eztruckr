import { prepareTestDatabase } from '@eztruckr/db';

/**
 * Migrate and seed the test database once, before any suite connects.
 *
 * The same call `packages/db` makes, and idempotent, so running either project
 * alone works and running both wastes only the second no-op.
 */
export async function setup(): Promise<void> {
  await prepareTestDatabase();
}
