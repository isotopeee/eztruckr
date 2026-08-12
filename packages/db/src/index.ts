export { Prisma, PrismaClient } from '../generated/client';
export type * from '../generated/client';

export { prisma, createPrismaClient } from './prisma-client';
export type { ExtendedPrismaClient } from './prisma-client';

export { withActor, getActor, getActorId } from './actor-context';
export type { Actor } from './actor-context';

export { auditExtension } from './audit-extension';
export { ensureEnvLoaded } from './load-env';

export {
  softDeleteExtension,
  isSoftDeletableModel,
  softDeletableModelNames,
} from './soft-delete-extension';
export { withDeleted, withHardDelete, getSoftDeleteScope } from './soft-delete-context';
export type { SoftDeleteScope } from './soft-delete-context';
