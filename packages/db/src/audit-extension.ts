import { Prisma } from '../generated/client';
import { getActorId } from './actor-context';

/**
 * Automatic createdBy / updatedBy stamping.
 *
 * Wired once here rather than repeated per model. Rules:
 *   - on create: createdBy = acting user, updatedBy forced to null
 *   - on update: updatedBy = acting user, createdBy left untouched
 *   - values supplied by a caller are always discarded, so a request body can
 *     never spoof them
 *
 * Nested writes are handled too: the walker follows relation fields via the
 * DMMF, so `shipment.create({ data: { billableExpenses: { create: [...] } } })`
 * stamps the children as well.
 *
 * createdAt / updatedAt are left to Prisma's own @default(now()) / @updatedAt.
 */

const CREATED_BY = 'createdBy';
const UPDATED_BY = 'updatedBy';

/** Models carrying both audit columns; everything else is passed through. */
const auditedModels = new Set(
  Prisma.dmmf.datamodel.models
    .filter(
      (model) =>
        model.fields.some((field) => field.name === CREATED_BY) &&
        model.fields.some((field) => field.name === UPDATED_BY),
    )
    .map((model) => model.name),
);

/** Relation field name -> related model name, per model. */
const relationTargets = new Map<string, Map<string, string>>(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(
      model.fields
        .filter((field) => field.kind === 'object' && field.relationName)
        .map((field) => [field.name, field.type]),
    ),
  ]),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Apply `stamp` to a value that may be a single payload or an array of them. */
function forEachPayload(
  value: unknown,
  model: string,
  actorId: string | null,
  stamp: (payload: Record<string, unknown>, model: string, actorId: string | null) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isPlainObject(entry)) stamp(entry, model, actorId);
    }
    return;
  }
  if (isPlainObject(value)) stamp(value, model, actorId);
}

/**
 * `createMany` payloads look like `{ data: [...] }`; plain nested creates are
 * the payload itself. This normalises both.
 */
function unwrapData(value: unknown): unknown {
  if (isPlainObject(value) && 'data' in value) return value.data;
  return value;
}

function stampCreate(
  payload: Record<string, unknown>,
  model: string,
  actorId: string | null,
): void {
  if (auditedModels.has(model)) {
    payload[CREATED_BY] = actorId;
    // updatedBy stays null until the row is first modified.
    payload[UPDATED_BY] = null;
  }
  walkRelations(payload, model, actorId);
}

function stampUpdate(
  payload: Record<string, unknown>,
  model: string,
  actorId: string | null,
): void {
  if (auditedModels.has(model)) {
    payload[UPDATED_BY] = actorId;
    // createdBy is immutable once set.
    delete payload[CREATED_BY];
  }
  walkRelations(payload, model, actorId);
}

/**
 * Descend into nested relation writes and stamp them with the operation that
 * matches the nested verb.
 */
function walkRelations(
  payload: Record<string, unknown>,
  model: string,
  actorId: string | null,
): void {
  const relations = relationTargets.get(model);
  if (!relations) return;

  for (const [field, value] of Object.entries(payload)) {
    const relatedModel = relations.get(field);
    if (!relatedModel || !isPlainObject(value)) continue;

    if ('create' in value) {
      forEachPayload(value.create, relatedModel, actorId, stampCreate);
    }
    if ('createMany' in value) {
      forEachPayload(unwrapData(value.createMany), relatedModel, actorId, stampCreate);
    }
    if ('update' in value) {
      // Either `{ update: {...} }` or `{ update: { where, data } }`.
      forEachPayload(unwrapData(value.update), relatedModel, actorId, stampUpdate);
    }
    if ('updateMany' in value) {
      forEachPayload(unwrapData(value.updateMany), relatedModel, actorId, stampUpdate);
    }
    if ('upsert' in value) {
      forEachPayload(value.upsert, relatedModel, actorId, (entry, entryModel, id) => {
        if (isPlainObject(entry.create)) stampCreate(entry.create, entryModel, id);
        if (isPlainObject(entry.update)) stampUpdate(entry.update, entryModel, id);
      });
    }
    if ('connectOrCreate' in value) {
      forEachPayload(value.connectOrCreate, relatedModel, actorId, (entry, entryModel, id) => {
        if (isPlainObject(entry.create)) stampCreate(entry.create, entryModel, id);
      });
    }
  }
}

export const auditExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'eztruckr-audit',
    query: {
      $allModels: {
        create({ model, args, query }) {
          const actorId = getActorId();
          if (isPlainObject(args.data)) stampCreate(args.data, model, actorId);
          return query(args);
        },
        createMany({ model, args, query }) {
          const actorId = getActorId();
          forEachPayload(args.data, model, actorId, stampCreate);
          return query(args);
        },
        createManyAndReturn({ model, args, query }) {
          const actorId = getActorId();
          forEachPayload(args.data, model, actorId, stampCreate);
          return query(args);
        },
        update({ model, args, query }) {
          const actorId = getActorId();
          if (isPlainObject(args.data)) stampUpdate(args.data, model, actorId);
          return query(args);
        },
        updateMany({ model, args, query }) {
          const actorId = getActorId();
          if (isPlainObject(args.data)) stampUpdate(args.data, model, actorId);
          return query(args);
        },
        upsert({ model, args, query }) {
          const actorId = getActorId();
          if (isPlainObject(args.create)) stampCreate(args.create, model, actorId);
          if (isPlainObject(args.update)) stampUpdate(args.update, model, actorId);
          return query(args);
        },
      },
    },
  }),
);
