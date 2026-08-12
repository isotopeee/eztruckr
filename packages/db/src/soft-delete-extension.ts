import { Prisma } from '../generated/client';
import { getActorId } from './actor-context';
import { getSoftDeleteScope, withDeleted } from './soft-delete-context';

/**
 * Soft-delete filtering, applied in exactly one place.
 *
 * Every read against a table that has `deletedAt` gets `deletedAt: null`
 * added, including relation reads reached through `include` / `select`. The
 * brief is right that this is the dangerous part: a hand-written filter per
 * query is guaranteed to be forgotten somewhere, and the failure is silent —
 * a deleted commission reappearing on a voucher, or a deleted shipment
 * skewing the P&L.
 *
 * Escapes are explicit and async-scoped: `withDeleted()` to see deleted rows,
 * `withHardDelete()` to permit a real DELETE.
 *
 * KNOWN LIMITATION — to-one relations are not filtered. Prisma accepts a
 * `where` on a to-many relation read but not on a to-one, so
 * `shipment.findMany({ include: { client: true } })` still returns a
 * soft-deleted client. That is the intended behaviour anyway: foreign keys
 * stay intact and a historical row must remain readable, including the name
 * of a client that has since been removed. Only collections — where a deleted
 * row would be silently counted or summed — are filtered.
 */

const DELETED_AT = 'deletedAt';

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

const modelsByName = new Map<string, DmmfModel>(
  Prisma.dmmf.datamodel.models.map((model) => [model.name, model]),
);

/** Models carrying a deletedAt column. Everything else passes through. */
const softDeletableModels = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === DELETED_AT))
    .map((model) => model.name),
);

/** Per model: relation field name -> { model, isList }. */
const relationTargets = new Map<string, Map<string, { model: string; isList: boolean }>>(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(
      model.fields
        .filter((field) => field.kind === 'object' && field.relationName)
        .map((field) => [field.name, { model: field.type, isList: field.isList }]),
    ),
  ]),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Prisma.getExtensionContext(this).$name` is not guaranteed to match the
 * DMMF casing, so resolve it rather than trusting the string. Getting this
 * wrong would make softDelete silently think a model is not soft-deletable.
 */
function resolveModelName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (modelsByName.has(raw)) return raw;
  const capitalised = raw.charAt(0).toUpperCase() + raw.slice(1);
  return modelsByName.has(capitalised) ? capitalised : undefined;
}

/**
 * Add `deletedAt: null` to a where clause unless the caller named `deletedAt`
 * themselves — an explicit filter always wins, which is what makes the
 * restore and "view deleted" paths expressible.
 */
function applyNotDeleted(where: unknown): Record<string, unknown> {
  if (!isPlainObject(where)) {
    return { [DELETED_AT]: null };
  }
  if (DELETED_AT in where) {
    return where;
  }
  return { ...where, [DELETED_AT]: null };
}

/**
 * Walk `include` / `select` and filter every to-many relation read.
 * `include: { commissions: true }` becomes
 * `include: { commissions: { where: { deletedAt: null } } }`.
 */
function filterNestedReads(args: Record<string, unknown>, modelName: string): void {
  const relations = relationTargets.get(modelName);
  if (!relations) return;

  for (const key of ['include', 'select'] as const) {
    const branch = args[key];
    if (!isPlainObject(branch)) continue;

    for (const [field, value] of Object.entries(branch)) {
      const relation = relations.get(field);
      if (!relation) continue;

      const nestedIsSoftDeletable = softDeletableModels.has(relation.model);

      // `true` carries no place to put a filter, so promote it to an object.
      if (value === true) {
        if (relation.isList && nestedIsSoftDeletable) {
          branch[field] = { where: { [DELETED_AT]: null } };
        }
        continue;
      }

      if (!isPlainObject(value)) continue;

      if (relation.isList && nestedIsSoftDeletable) {
        value.where = applyNotDeleted(value.where);
      }

      // Recurse: an include can nest arbitrarily deep.
      filterNestedReads(value, relation.model);
    }
  }
}

/** Operations whose `where` selects rows to return. */
const READ_OPERATIONS = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
] as const;

export const softDeleteExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'eztruckr-soft-delete',

    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = getSoftDeleteScope();

          // Hard deletes are refused outright. Soft delete is the only way to
          // remove a business row, so history can never be destroyed by a
          // stray service call.
          if (operation === 'delete' || operation === 'deleteMany') {
            if (softDeletableModels.has(model) && !scope.allowHardDelete) {
              throw new Error(
                `Hard delete is not permitted on ${model}. Soft-delete it by setting ` +
                  `deletedAt, or wrap the call in withHardDelete() if this is a ` +
                  `deliberate administrative purge.`,
              );
            }
            return query(args);
          }

          const isRead = (READ_OPERATIONS as readonly string[]).includes(operation);
          if (!isRead) {
            return query(args);
          }

          const typedArgs = (isPlainObject(args) ? args : {}) as Record<string, unknown>;

          // Opting in applies wholesale, top level and nested alike: a restore
          // screen has to be able to show a deleted shipment's deleted charges.
          if (!scope.includeDeleted) {
            if (softDeletableModels.has(model)) {
              typedArgs.where = applyNotDeleted(typedArgs.where);
            }
            filterNestedReads(typedArgs, model);
          }

          return query(typedArgs);
        },
      },
    },

    model: {
      $allModels: {
        /**
         * Soft-delete rows matching `where`, stamping deletedBy from the
         * ambient actor. Returns the number of rows affected.
         */
        async softDelete<T>(this: T, where: Record<string, unknown>): Promise<number> {
          const context = Prisma.getExtensionContext(this) as unknown as {
            $name?: string;
            updateMany: (args: unknown) => Promise<{ count: number }>;
          };

          const modelName = resolveModelName(context.$name);
          if (!modelName || !softDeletableModels.has(modelName)) {
            throw new Error(
              `${context.$name ?? 'model'} has no deletedAt column and cannot be soft-deleted.`,
            );
          }

          const result = await context.updateMany({
            // Already-deleted rows are skipped so the original deletedAt and
            // deletedBy are never overwritten by a second delete.
            where: { ...where, [DELETED_AT]: null },
            data: { [DELETED_AT]: new Date(), deletedBy: getActorId() },
          });

          return result.count;
        },

        /**
         * Restore soft-deleted rows. Runs inside `withDeleted` so the target
         * rows are visible to the update in the first place.
         */
        async restore<T>(this: T, where: Record<string, unknown>): Promise<number> {
          const context = Prisma.getExtensionContext(this) as unknown as {
            $name?: string;
            updateMany: (args: unknown) => Promise<{ count: number }>;
          };

          const modelName = resolveModelName(context.$name);
          if (!modelName || !softDeletableModels.has(modelName)) {
            throw new Error(
              `${context.$name ?? 'model'} has no deletedAt column and cannot be restored.`,
            );
          }

          return withDeleted(async () => {
            const result = await context.updateMany({
              where: { ...where, [DELETED_AT]: { not: null } },
              data: { [DELETED_AT]: null, deletedBy: null },
            });
            return result.count;
          });
        },
      },
    },
  }),
);

/** Exposed for tests and tooling; mirrors what the extension protects. */
export function isSoftDeletableModel(model: string): boolean {
  return softDeletableModels.has(model);
}

export function softDeletableModelNames(): readonly string[] {
  return Object.freeze([...softDeletableModels].sort());
}

export function modelExists(model: string): boolean {
  return modelsByName.has(model);
}
