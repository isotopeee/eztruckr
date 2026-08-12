# EZTruckr

Trucking management for a Philippine hauling company — shipments end to end:
freight rates, third-party broker commissions, crew assignment, cash advances
and liquidation, client charges, crew commissions, commission payouts, and
profit and loss.

> **Status: Phase 4 (Shipments and the money engine).** The monorepo, containers
> and both apps are up, the complete domain schema is migrated and seeded, and
> you can sign in, manage master data, book and dispatch a shipment, record its
> charges, and compute crew commissions against any of five commission methods.
> Still to come: allowance and liquidation, payout runs, and P&L.

---

## Quick start

First, set an auth secret — the API refuses to boot without one:

```bash
cp .env.example .env && printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env
```

Then bring the whole stack up with one command:

```bash
docker compose up -d --build
```

That starts PostgreSQL, MinIO (creating the `eztruckr` bucket), applies Prisma
migrations, seeds an administrator you can sign in as, and boots both apps:

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

Then sign in at http://localhost:3000 as the seeded administrator:

| Email               | Password             |
| ------------------- | -------------------- |
| `admin@eztruckr.ph` | `eztruckr-dev-admin` |

Development only — override with `SEED_ADMIN_PASSWORD` in `.env`. The seed
creates the credential on first run and never touches an existing one, so it
will not reset a password you have changed. There is no public sign-up: every
other account is created by an administrator under **Users**.

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
pnpm db:seed                                     # admin login + master data
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
| `pnpm db:seed`    | Seed the administrator, settings and master data |
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
(`withActor`), opened by `SessionContextMiddleware` from the Better Auth
session, so no service has to thread a `userId` through its signatures.

### Timestamps

`DateTime` columns are `timestamptz`, stored UTC. Asia/Manila is applied only
at display time via `formatDateTime` in `apps/web/src/lib/format.ts`.

### Rates are frozen

When a commission is computed, the rate values actually used are copied onto the
shipment and the commission, so a later edit to a setting or a rule can never
retroactively alter a figure already computed. Anything named `applied*` is one
of these frozen copies.

A commission rule is flat per role and scope: a rate, a fixed amount, or a
formula, chosen by its method. Rates that vary by trip value in _bands_ are
deliberately not supported — a `FORMULA` rule can express a value-dependent
amount arithmetically, but there is no tiered-band feature.

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
- **Order in `main.ts` is load-bearing, twice over.** The app is created with
  `bodyParser: false` and the Better Auth handler is mounted before the JSON
  parser is turned back on — Better Auth reads the raw request stream, and a
  parser ahead of it consumes the body so every sign-in arrives empty. CORS is
  enabled before that mount, because `enableCors` registers Express middleware
  in call order and the auth handler ends the response itself; enabling CORS
  afterwards leaves exactly the sign-in route without the headers, which fails
  only in a browser and only cross-origin.
- **TanStack Query never retries a 4xx and never pauses when "offline".** A 403
  is a settled answer, and a paused query renders as pending forever — an
  unexplained spinner with no error. See the comments in `providers.tsx`.

---

## Authorisation

Authentication is Better Auth over the `user` / `session` / `account` /
`verification` tables. Two global guards run on every request:

- `AuthenticatedGuard` — a session is required unless the route is `@Public()`,
  and a deactivated account is refused with a message that says so.
- `RolesGuard` — **fails closed**. A route with no `@Roles(...)` declaration is
  refused outright, so a controller added without one returns 403 on its first
  call rather than being open until someone notices.

Roles are a membership test, never a ranking. Who may do what is declared once
in `auth/role-policy.ts`. Crew logins are confined to their own records, checked
server-side against the session's `crewMemberId` — changing the id in the URL
gets a 403, whether or not the UI rendered the link.

### One source of truth for crew pay

`CommissionRule` is the only place a driver or helper rate is defined. There is
deliberately no fallback: a shipment matching no rule must be an error the
engine raises, not a number it invents. `SystemSetting` once carried fallback
rates, which was two places to look for one number — and the weaker of the two,
since a fallback has no effective window, no scope and no priority, so it could
not answer "what was the helper rate in March?". The seeded unscoped,
open-ended, priority-0 rules are the company-wide baseline.

`gasExpenseDeductionRate` does stay on `SystemSetting`: it is not per-role, so
it has no rule equivalent, and putting it on a per-role rule would let a driver
rule and a helper rule disagree about the commissionable base of the same
shipment. It is _surfaced_ on both the settings screen and the commission rules
screen through one shared component that reads and writes the same row —
surfaced twice, stored once.

System settings are administrator-only including the read: the rates are
company financial policy, not reference data. When a later screen needs to show
the gas deduction rate beside a commission it computed, that should be a narrow
endpoint returning just that value, rather than this one widened until it is no
longer administrator-only in any meaningful sense.

### Removing master data

Delete is not one operation. Before removing anything the service counts what
refers to it:

| Situation                                  | Outcome        |
| ------------------------------------------ | -------------- |
| Something still refers to it               | `DEACTIVATED`  |
| Nothing refers to it                       | `SOFT_DELETED` |
| Nothing refers to it, and it is a category | `HARD_DELETED` |

The response says which happened and what referred to the record, and the UI
reports it — "delete" that silently means "deactivate" is how someone ends up
believing a truck is gone while it still prints on last month's vouchers.
Expense categories are the only table that can be truly deleted, and only while
unused: they are classification, not history. Every business foreign key is
`ON DELETE RESTRICT`, so the database is a real second line of defence.

---

## Phase 1 scope

Built: Turborepo workspaces; docker compose with PostgreSQL and MinIO plus
Dockerfiles for both apps; Prisma with the audit-stamping extension and a
`SystemSetting` singleton; NestJS with a health check, schema-validated config
and a global Zod validation pipe; Next.js with Tailwind, shadcn/ui and TanStack
Query; shared Prettier/ESLint/tsconfig wired into `turbo.json`.

## Phase 2 scope

Built: the full 23-table domain model with SMALLINT code sets instead of
Postgres enums, soft delete everywhere behind a single Prisma extension,
partial unique indexes, five payout-idempotency triggers, and an idempotent
seed.

## Phase 3 scope

Built: Better Auth wired to the existing tables with role, `isActive` and
`crewMemberId` as non-client-settable additional fields; global authentication
and fail-closed role guards; crew scoping; full CRUD for all seven master data
tables with reference-aware removal; admin-only system settings with a change
history written to `AuditLog`; and the web app — login, role-aware app shell,
management screens and a crew portal.

## Phase 4 scope

Built: shipment CRUD with the gross → TPC → net rate chain; the status
lifecycle; crew assignment with driver-licence validation; billable expenses
and additional charges with commissionable flags; the per-shipment gas
deduction override; and the commission engine — five methods behind one
dispatch table, rule resolution with no fallback, and every applied rate frozen
onto the rows it produced.

Not yet built: allowance and liquidation (Phase 5), payout runs, and P&L.

### The commission formula language

A `CommissionRule` using the `FORMULA` method carries an expression over a fixed
catalog of shipment fields, e.g. `commissionable_base * 0.15`.

**This is a security boundary and is treated as one.** The expression is parsed
by hand into an AST and walked — never handed to `eval`, `Function`, `vm`, or
any third-party evaluator. The entire grammar is:

```
expression := term (('+' | '-') term)*
term       := factor (('*' | '/') factor)*
factor     := '-' factor | primary
primary    := NUMBER | FIELD | '(' expression ')'
```

There are no function calls, no property access, no strings, and no identifier
outside the catalog. Anything else is rejected **at save time**, with a message
naming the offending token, so a rule that failed to parse is never stored.

Fields: `gross_rate`, `tpc_amount`, `net_rate`, `billable_expenses`,
`additional_charges`, `commissionable_charges`, `gas_deduction_rate`,
`gas_deduction_amount`, `commissionable_base`. `GET /api/commissions/formula-fields`
serves them with descriptions.

**The double-counting trap.** `commissionable_base` already has the gas
deduction applied — subtracting `gas_deduction_amount` from it deducts fuel
twice, and no evaluator can tell that apart from a deliberate choice. Likewise
`commissionable_charges` is a _subset_ of the two charge totals, not a third
category. Composing a correct expression is the rule author's job; the catalog
descriptions exist so the trap is visible where they write it.

Arithmetic is exact. The evaluator walks the AST in BigInt rationals
(`apps/api/src/commission/rational.ts`) and rounds **once**, at the end, to 2dp
half-up. It does not use currency.js, because currency.js is fixed at precision
2 and a formula has no stored intermediates to round — the literal `0.075`
alone would become `0.08`. The rounding rule is matched to currency.js
deliberately, so `commissionable_base * 0.075` and a `PERCENT_OF_BASE` rule at
7.5% agree to the centavo.

Divide-by-zero and a negative result are errors surfaced to the user, never
clamped to zero.
