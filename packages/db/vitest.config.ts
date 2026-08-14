import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './src/test-database';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The suites run against a SEPARATE database from development — see
    // `test-database.ts`. Set here rather than in globalSetup because that
    // runs in its own process and cannot reach the workers' environment.
    env: { DATABASE_URL: testDatabaseUrl() },
    globalSetup: ['./vitest.global-setup.ts'],
    // Integration tests share one database, so they must not race each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
