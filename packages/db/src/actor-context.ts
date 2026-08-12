import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The user a unit of work is being performed on behalf of.
 *
 * This is ambient, request-scoped state: the API sets it once per request and
 * every Prisma write underneath picks it up automatically. Nothing else may
 * supply createdBy / updatedBy — in particular, never a request body.
 */
export interface Actor {
  /** User.id of the acting user, or null for system/unauthenticated writes. */
  userId: string | null;
}

const storage = new AsyncLocalStorage<Actor>();

/**
 * Run `fn` with `actor` as the acting user for every write it performs.
 *
 * IMPORTANT — await inside `fn`, do not return an un-awaited Prisma call.
 * Prisma's query methods return a LAZY `PrismaPromise`: nothing executes until
 * it is awaited. So this loses the actor and stamps null:
 *
 *     withActor(actor, () => prisma.truck.create({ data }))     // WRONG
 *
 * because the await happens after `storage.run` has already returned. Write it
 * so the await is inside the scope:
 *
 *     withActor(actor, async () => prisma.truck.create({ data }))   // ok
 *     withActor(actor, async () => { await prisma.truck.create(...) }) // ok
 *
 * An `async` arrow is enough: its body runs inside the scope and async
 * continuations inherit it. Request handling is unaffected — the middleware
 * wraps the whole request, so every await sits inside the scope already.
 */
export function withActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

/** The acting user for the current async context, if any. */
export function getActor(): Actor | undefined {
  return storage.getStore();
}

/** The acting user's id, or null when running outside a request (seeds, jobs). */
export function getActorId(): string | null {
  return storage.getStore()?.userId ?? null;
}
