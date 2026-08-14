import { testDatabaseUrl } from '@eztruckr/db';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The DB-backed suites run against a SEPARATE database from development —
    // see `test-database.ts` in `packages/db`. Set here rather than in
    // globalSetup because that runs in its own process.
    env: { DATABASE_URL: testDatabaseUrl() },
    globalSetup: ['./vitest.global-setup.ts'],
    // Suites share one database and reserve a uuid block each, but the shared
    // reference data they read is not partitioned, so they must not race.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  esbuild: {
    target: 'es2022',
  },
});
