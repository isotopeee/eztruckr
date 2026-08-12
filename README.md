# EZTruckr

Trucking management for a Philippine hauling company — shipments end to end:
freight rates, third-party broker commissions, crew assignment, cash advances
and liquidation, client charges, crew commissions, commission payouts, and
profit and loss.

> **Status: Phase 2 (Data model).** The monorepo, containers and both apps are
> up, and the complete domain schema is migrated and seeded. Still to come:
> Better Auth, role and crew scoping, the commission engine, the API surface
> and the UI.

---

## Quick start

Bring the whole stack up with one command:

```bash
docker compose up -d --build
```

That starts PostgreSQL, MinIO (creating the `eztruckr` bucket), applies Prisma
migrations, and boots both apps:

| Service       | URL                              | Notes                                   |
| ------------- | -------------------------------- | --------------------------------------- |
| Web           | http://localhost:3000            | Next.js admin + crew portal             |
| API           | http://localhost:4000/api        | NestJS                                  |
| Health check  | http://localhost:4000/api/health | database + storage probes               |
| MinIO console | http://localhost:9011            | `eztruckr` / `eztruckr-secret`          |
| PostgreSQL    | `localhost:5433`                 | `eztruckr` / `eztruckr` / db `eztruckr` |

Verify:

```bash
curl -s http://localhost:4000/api/health
```

```json
{
  "status": "ok",
  "uptimeSeconds": 12,
  "timestamp": "2026-08-12T11:21:00.503Z",
  "checks": { "database": "up", "storage": "up" }
}
```

Tear down (add `-v` to also drop the database and bucket volumes):

```bash
docker compose down
```

### Host ports

Host ports avoid the common defaults so EZTruckr can run alongside other local
projects. Container-internal ports are unchanged. Override any of them in
`.env`: `POSTGRES_PORT` (5433), `MINIO_PORT` (9010), `MINIO_CONSOLE_PORT`
(9011), `API_PORT` (4000), `WEB_PORT` (3000).

---

## Local development

Run the datastores in Docker and the apps on your machine for fast reloads.

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres minio minio-init   # datastores only
pnpm db:migrate                                  # apply migrations
pnpm db:seed                                     # seed system settings
pnpm dev                                         # web + api in watch mode
```

Requires Node >= 20.11 and pnpm 11.

### Commands

| Command           | Does                                             |
| ----------------- | ------------------------------------------------ |
| `pnpm dev`        | Run every app in watch mode                      |
| `pnpm build`      | Build all workspaces                             |
| `pnpm check`      | Format check + lint + typecheck + test (CI gate) |
| `pnpm test`       | Run test suites                                  |
| `pnpm format`     | Rewrite files with Prettier                      |
| `pnpm db:migrate` | Create/apply a migration                         |
| `pnpm db:seed`    | Seed the singleton system settings row           |
| `pnpm db:studio`  | Open Prisma Studio                               |

---

## Layout

```
eztruckr/
├─ apps/
│  ├─ web/          # Next.js (App Router) — admin app + crew portal
│  └─ api/          # NestJS
├─ packages/
│  ├─ db/           # Prisma schema, migrations, generated client, audit extension
│  ├─ types/        # shared TypeScript types, Zod schemas, money helper
│  └─ config/       # shared tsconfig, eslint, prettier
├─ docker-compose.yml
└─ turbo.json
```

---

## Engineering rules

These are load-bearing. Money correctness is the point of the system.

### Money is never a raw float

Two layers with a strict boundary:

- **Storage** — Prisma `Decimal`. Money is `@db.Decimal(15, 4)`, percentages
  are `@db.Decimal(5, 4)`. Never `Float`.
- **Computation** — currency.js, configured **once** in
  [`packages/types/src/money/money.ts`](packages/types/src/money/money.ts) as
  `{ symbol: '₱', precision: 2 }`. Import `money()` from there; never call
  `currency(...)` ad hoc.

Read a `Decimal` via its **string** value, compute, then write back with
`.toString()`:

```ts
import { money, multiplyByRate, toDecimalString } from '@eztruckr/types';

const netRate = money(shipment.netRate); // Decimal -> currency via toString()
const gasDeduction = multiplyByRate(netRate, settings.gasExpenseDeductionRate);
await prisma.shipment.update({
  where: { id },
  data: { gasDeduction: toDecimalString(gasDeduction) },
});
```

Never use `.toNumber()`, and never do money arithmetic with bare `+ - * /` on a
`number`. `MoneyInput` deliberately excludes `number` so the type system
enforces this rather than relying on discipline.

Percentages are the one exception: rates like `0.15` are multipliers, not
money, and are passed to `currency.multiply()` without being wrapped.

All financial computation lives in the backend. The frontend displays computed
values and never calculates commissions, bases or totals.

### Rounding

Every step of the commission chain stores a value, so each step rounds to 2dp
before feeding the next. A reviewer must be able to reproduce every figure with
a calculator from what's on screen: the stored `commissionableBase` times the
stored rate equals the stored commission, exactly.

### Audit columns

Every business table has `createdAt`, `updatedAt`, `createdBy`, `updatedBy`.
They are stamped automatically by the Prisma client extension in
[`packages/db/src/audit-extension.ts`](packages/db/src/audit-extension.ts) —
wired once, not per model, and it follows nested writes via the DMMF.

`createdBy`/`updatedBy` are **never** accepted from a request body; the global
Zod pipe strips unknown keys and the extension overwrites them regardless.
`updatedBy` stays `null` until a row is first modified.

The acting user comes from request-scoped `AsyncLocalStorage`
(`withActor`), opened by `ActorContextMiddleware`, so no service has to thread
a `userId` through its signatures.

### Timestamps

`DateTime` columns are `timestamptz`, stored UTC. Asia/Manila is applied only
at display time via `formatDateTime` in `apps/web/src/lib/format.ts`.

### Rates are frozen

System settings supply defaults only. When a commission is computed, the rate
values actually used are stored on the shipment, so later settings changes can
never retroactively alter a computed commission.

Commission rates are flat per role and scope. Rates that vary by trip value are
deliberately not supported.

### Enumerated values are integer codes, not Postgres enums

There are no `enum` blocks in the Prisma schema and no native Postgres enum
types. Every enumerated value is `Int @db.SmallInt`, and each code set is
declared exactly once in
[`packages/types/src/codes`](packages/types/src/codes) as a frozen const object
with a derived union type and a label map. A bare numeric literal for a code
should appear nowhere else.

**Codes are permanent.** Never renumber, never reuse, append only — a stored
row holds the number, not the name, so renumbering silently rewrites history.
`code-set.test.ts` pins every value for exactly that reason.

**Never infer order from the number.** Codes are appended, so they are neither
contiguous nor in workflow order. Use the declared sequence:

```ts
import { ShipmentStatus, shipmentStatusAtLeast } from '@eztruckr/types';

// "a shipment cannot close before it is liquidated"
if (!shipmentStatusAtLeast(shipment.status, ShipmentStatus.LIQUIDATED)) {
  throw new Error('Cannot close before liquidation');
}
```

Each code column has a CHECK constraint listing its valid codes and a SQL
`COMMENT` decoding them, so raw SQL is readable and a bad write fails at the
database. The constraint SQL necessarily repeats the numbers —
`code-constraints.test.ts` reads them back out of the catalog and compares them
against the TypeScript, so the two cannot drift.

### Soft delete

Every business table has nullable `deletedAt` / `deletedBy`, and nothing is
ever hard-deleted. Filtering happens in exactly one place — the client
extension in
[`packages/db/src/soft-delete-extension.ts`](packages/db/src/soft-delete-extension.ts)
adds `deletedAt: null` to every read, **including nested collection reads**,
and refuses `delete` / `deleteMany` outright.

```ts
await prisma.shipment.softDelete({ id }); // sets deletedAt + deletedBy
await prisma.shipment.restore({ id }); // clears them
await withDeleted(async () => prisma.shipment.findMany()); // admin view
```

`isActive` is a **separate** concept and is not collapsed into deletion:
deactivated means still valid on history but not offered for new entries (a
sold truck, a departed crew member); deleted means removed from use.

Unique constraints on these tables are **partial** (`WHERE "deletedAt" IS
NULL`), so a deleted row does not reserve its code forever. Prisma cannot
express partial uniqueness, so those columns carry no `@unique` and the indexes
are created by migration.

**One deliberate exception:** `commission."payoutLineId"` is a _full_ unique. A
soft-deleted commission must still count as paid, so deleting it can never
release its payout line. Triggers additionally refuse to move, clear, delete or
soft-delete a paid commission. This is asserted in
[`payout-idempotency.test.ts`](packages/db/src/payout-idempotency.test.ts).

### Two gotchas that cost real time

**`withActor` needs the await inside the scope.** Prisma query methods return a
_lazy_ `PrismaPromise` — nothing runs until awaited. So this silently stamps
`createdBy` as null:

```ts
withActor(actor, () => prisma.truck.create({ data })); // WRONG
withActor(actor, async () => prisma.truck.create({ data })); // ok
```

**`createdBy` is nullable to Prisma, mandatory in Postgres.** The audit
extension supplies it at query time, which the generated types cannot see, so a
required column made every `create()` demand a value the caller must never
provide. It is nullable in the schema and enforced by
`<table>_created_by_required` CHECK constraints instead; Prisma's differ ignores
CHECK constraints, so there is no drift.

### Verifying the database guarantees

The guarantees above are enforced by constraints and triggers, so they are
tested against a real database. Bring the datastores up and seed first:

```bash
pnpm --filter @eztruckr/db test
```

### Conventions

- Kebab-case filenames throughout.
- Prettier is enforced monorepo-wide as the Turborepo root task
  `//#format:check`, included in `pnpm check`.

---

## Gotchas worth knowing

- **Don't start a client-component filename with `api`.** Next.js excludes such
  files from the RSC client manifest, and the build fails at prerender with
  `Could not find the module … in the React Client Manifest`. This is why the
  health card is `health-status-card.tsx`. Non-component modules such as
  `lib/api-client.ts` are unaffected.
- **`*.tsbuildinfo` is in `.dockerignore`** alongside `dist/`. TypeScript's
  incremental mode trusts that file over the filesystem, so copying a host
  `tsbuildinfo` into an image that has no `dist/` makes `tsc` think the output
  is current and emit nothing — producing a confusing "cannot find module"
  failure downstream.
- **`consistent-type-imports` is off for the API.** NestJS constructor
  injection makes a class appear in type position only; rewriting it to
  `import type` would erase the runtime value that `emitDecoratorMetadata`
  needs, breaking DI at boot.

---

## Phase 1 scope

Built: Turborepo workspaces; docker compose with PostgreSQL and MinIO plus
Dockerfiles for both apps; Prisma with the audit-stamping extension and a
`SystemSetting` singleton; NestJS with a health check, schema-validated config
and a global Zod validation pipe; Next.js with Tailwind, shadcn/ui and TanStack
Query; shared Prettier/ESLint/tsconfig wired into `turbo.json`.

Not yet built: Better Auth, roles and crew scoping, and the domain model
(shipments, crew, charges, liquidation, commissions, payout runs, P&L).
