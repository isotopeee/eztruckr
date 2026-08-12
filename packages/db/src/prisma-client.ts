import { PrismaClient } from '../generated/client';
import { auditExtension } from './audit-extension';
import { ensureEnvLoaded } from './load-env';
import { softDeleteExtension } from './soft-delete-extension';

/**
 * The one way to get a Prisma client in this monorepo.
 *
 * Always audit-extended, so createdBy / updatedBy are stamped no matter which
 * module performs the write.
 */
export function createPrismaClient() {
  ensureEnvLoaded();

  const base = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
  });

  // Order matters only for readability: audit stamps writes, soft delete
  // filters reads and blocks hard deletes. There is no unextended client
  // anywhere in the monorepo, so neither guarantee can be bypassed by
  // reaching for a "plain" client.
  return base.$extends(auditExtension).$extends(softDeleteExtension);
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * Cached across hot reloads in development so we don't exhaust the connection
 * pool on every file change.
 */
const globalForPrisma = globalThis as unknown as {
  eztruckrPrisma?: ExtendedPrismaClient;
};

export const prisma: ExtendedPrismaClient = globalForPrisma.eztruckrPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.eztruckrPrisma = prisma;
}
