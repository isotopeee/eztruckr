import path from 'node:path';
import { config } from 'dotenv';

let loaded = false;

/**
 * Make sure DATABASE_URL is present before a Prisma client is constructed.
 *
 * The monorepo keeps one .env at the root, but scripts in this package run
 * with their own cwd (seeds, migrations, tests). This resolves the root file
 * relative to the compiled/executed file rather than to cwd.
 *
 * A no-op whenever the environment already supplies the variable — which is
 * the case in Docker and CI — so it never overrides real configuration.
 */
export function ensureEnvLoaded(): void {
  if (loaded || process.env.DATABASE_URL) {
    loaded = true;
    return;
  }

  // Both src/ (tsx) and dist/ (compiled) sit two levels under the repo root.
  config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  loaded = true;
}
