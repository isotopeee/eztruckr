import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * The monorepo keeps a single .env at the root, but the Prisma CLI looks
 * beside the schema. Load the root file explicitly so `prisma migrate` works
 * from anywhere, then fall back to a package-local .env if one exists.
 */
loadEnv({ path: path.resolve(__dirname, '../../.env'), quiet: true });
loadEnv({ path: path.resolve(__dirname, '.env'), override: true, quiet: true });

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
