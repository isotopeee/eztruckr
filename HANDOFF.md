# EZTruckr — Session Handoff

Trucking management system for a Philippine hauling company. Turborepo monorepo, built in phases. This document summarizes everything completed through **Phase 3** so a new session can continue without replaying history.

**Git initialized.** Branch `main`, initial commit `3af269a` covers all of Phase 1 + Phase 2. No remote configured.

---

## Repository layout (as built)

```
eztruckr/
├─ apps/
│  ├─ web/          # Next.js 15 App Router, Tailwind v4, shadcn/ui, TanStack Query
│  └─ api/          # NestJS 11, health check, Zod validation pipe
├─ packages/
│  ├─ db/           # Prisma schema (27 tables), migrations, audit + soft-delete extensions
│  ├─ types/        # Money helper, Zod schemas, code sets (const-object enums)
│  └─ config/       # Shared tsconfig/eslint/prettier, imported via workspace protocol
├─ docker-compose.yml   # postgres (5433), minio (9010/9011), api (4000), web (3000)
├─ turbo.json
└─ pnpm-workspace.yaml
```

Host ports deliberately non-standard (5433/9010/9011) to avoid colliding with another local Docker project (`shipper`) that owns 5432/9000/9001. Override via `.env` (`POSTGRES_PORT`, `MINIO_PORT`, etc).

---

## Phase 1 — Foundation ✅

- Turborepo workspaces: `apps/web`, `apps/api`, `packages/db`, `packages/types`, `packages/config`.
- `docker-compose.yml`: Postgres 16, MinIO (+ `minio-init` one-shot bucket creator), Dockerfiles for api/web (multi-stage, `node:22-bookworm-slim`, Prisma needs glibc/OpenSSL not Alpine).
- Prisma initialized in `packages/db`, connected to compose Postgres. `prisma.config.ts` loads root `.env` explicitly (Prisma CLI otherwise looks beside the schema, not at repo root).
- NestJS: health check (`/api/health` — checks DB + S3), `AppConfigModule` with Zod-validated env (`envSchema` in `config/env-schema.ts`), global `ZodValidationPipe` that **strips unknown fields** (so `createdBy` in a request body is discarded).
- Next.js: Tailwind v4, shadcn/ui (`new-york` style), TanStack Query provider, health-status card component.
- `packages/config`: shared Prettier config (`₱` not relevant here, just formatting), shared ESLint flat configs (base/nest/next), shared tsconfig bases.
- README with `docker compose up -d --build` as the one-command bring-up.

### Known gotchas documented in README

- **Client-component filenames starting with `api` break Next's RSC client manifest** — build fails with a cryptic "Could not find the module in the React Client Manifest" error. Confirmed via bisection: filename alone, not content. Renamed `api-status-card.tsx` → `health-status-card.tsx`.
- **`*.tsbuildinfo` must be in `.dockerignore`** alongside `dist/` — TypeScript's incremental mode trusts a stale tsbuildinfo over the filesystem, so copying a host tsbuildinfo into a fresh Docker layer with no `dist/` makes tsc silently emit nothing.
- **`consistent-type-imports` ESLint rule is OFF for NestJS** (`packages/config/eslint/nest.mjs`) — it would rewrite constructor-injected classes to `import type`, erasing them at compile time and breaking DI (`emitDecoratorMetadata` needs the runtime value).

---

## Phase 2 — Data model ✅ (through two rounds)

### Round 1 (superseded)

Original Phase 2 request used Postgres native `enum` blocks and relation-based `createdBy`/`updatedBy` (no soft delete). This was **entirely replaced** by Round 2 below — the user later expanded requirements to forbid Postgres enums and require soft delete everywhere. A tiered-commission-rate feature was also added then explicitly reverted (see below) before the enum/soft-delete rewrite.

### Round 2 (current, final state)

**23 business tables + 4 Better Auth infra tables (session/account/verification, no audit cols) = 27 total.**

Entities: `User`, `UserProfile`, `Truck`, `CrewMember`, `Client`, `ThirdParty`, `Route`, `ExpenseCategory`, `CommissionRule`, `SystemSetting`, `Shipment`, `Allowance`, `Liquidation`, `LiquidationLine`, `Receipt`, `BillableExpense`, `AdditionalCharge`, `CrewDeduction`, `Adjustment`, `Commission`, `PayoutRun`, `PayoutLine`, `AuditLog`.

#### No Postgres enums — SMALLINT codes instead

- **Zero** `enum` blocks in `schema.prisma`, zero native Postgres enum types (verified via `pg_type WHERE typtype='e'`).
- Every enumerated column is `Int @db.SmallInt`.
- Code sets declared **once each** in `packages/types/src/codes/*.ts` as frozen `as const` objects + derived union types + label maps + a `defineCodeSet()` helper providing `isValid`/`schema` (Zod).
- Code sets defined: `ShipmentStatus` (1-6), `LiquidationStatus` (1-3), `CrewRole` (1-2), `AdjustmentDirection` (1-2), `UserRole` (1-5), `CommissionMethod` (1-5, where 5=TIERED is **reserved/unimplemented** — `isImplementedCommissionMethod()` rejects it at the service layer, not the DB), and `PayoutRunStatus` (1-4, added beyond the brief because "PAID is terminal" needs a lifecycle).
- **Codes are permanent**: never renumbered, never reused, append-only. Enforced by convention + `code-set.test.ts` pinning every value.
- **Order-dependent logic uses declared sequences, never raw number comparison** — e.g. `shipmentStatusAtLeast(candidate, reference)` looks up position in `SHIPMENT_STATUS_SEQUENCE`, not `candidate >= reference`.
- Each code column has a **CHECK constraint** (migration `20260812135900_code_constraints_and_comments`) listing valid codes explicitly (not `BETWEEN`, since codes aren't guaranteed contiguous) and a SQL `COMMENT ON COLUMN` decoding it.
- **Drift guard**: `code-constraints.test.ts` reads live CHECK constraint definitions out of `pg_constraint` and diffs them against the TypeScript code sets — the one unavoidable duplication (migrations are static SQL, can't import TS) is kept honest by this test.

#### Soft delete everywhere

- Every business table: nullable `deletedAt` (timestamptz) + `deletedBy` (FK to User).
- **No hard deletes, ever.** Application-level enforcement: the soft-delete Prisma extension (`packages/db/src/soft-delete-extension.ts`) throws on `delete`/`deleteMany` unless explicitly permitted via `withHardDelete()` (test-only escape).
- **Filtering happens in exactly one place**: the extension adds `deletedAt: null` to every read (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`), including **nested to-many relation reads** reached via `include`/`select` (walks the DMMF relation graph recursively).
- Explicit opt-in: `withDeleted(fn)` (AsyncLocalStorage-scoped) for admin "view deleted" and restore paths.
- `softDelete()` and `restore()` added as Prisma client-extension model methods on every soft-deletable model.
- **Known limitation, documented, not a bug**: to-one relations are NOT filtered (Prisma doesn't support `where` on to-one includes). A soft-deleted `client` still shows up on a historical `shipment.client` read — intentional, since history must stay readable.
- `isActive` kept as a **separate concept** from `deletedAt` — deactivated (still valid on history, hidden from new-entry pickers, e.g. sold truck) vs deleted (removed from use entirely). Never collapsed.
- **Unique constraints are partial** (`WHERE "deletedAt" IS NULL`) — Prisma can't express partial uniqueness, so schema.prisma has no `@unique` on these columns; the partial indexes are hand-written SQL in migration `20260812135930_partial_uniques_and_payout_guards`. This means some 1:1 Prisma relations became 1:many at the type level (`shipment.liquidations[]` not `.liquidation`, `user.profiles[]`, `crewMember.logins[]`) even though the DB guarantees at most one live row — **flagged to user as needing confirmation, not yet resolved**.
- **Deliberate exception**: `commission.payoutLineId` is a **full** (non-partial) unique index. A soft-deleted commission must still count as paid.

#### Payout idempotency (the hardest guarantee)

- Problem: partial unique on `(shipmentId, role)` for commissions means soft-deleting a paid commission would free that slot, letting a replacement be computed and the same trip paid twice — while the original still reads as paid, so nothing looks wrong in reports.
- Solved with 5 Postgres triggers (migration `20260812135930_...`):
  1. `commission_payout_link_is_immutable` — can't move or clear a paid commission's `payoutLineId`.
  2. `paid_commission_no_soft_delete` — can't set `deletedAt` on a paid commission.
  3. `paid_commission_no_delete` — can't hard-delete a paid commission (defense in depth, since app code can't reach hard delete anyway).
  4. `paid_payout_line_no_delete` — can't delete a payout line belonging to a PAID run (would `SET NULL` cascade and free the commission).
  5. `paid_payout_run_is_terminal` — PAID run can never change status or be soft-deleted.
- **Asserted in 7 integration tests** (`payout-idempotency.test.ts`, hits real DB): soft-delete via client, soft-delete via raw SQL, re-point link, clear link, delete-then-recreate, hard-delete of commission/line, void/delete a PAID run. All pass.

#### `createdBy` nullable-to-Prisma / mandatory-in-Postgres pattern

- **Non-obvious but important**: making `createdBy: String` (required) in schema.prisma caused **19 TypeScript errors** — Prisma's generated types then demanded every `.create()` call site pass `createdBy` explicitly, which defeats "stamped automatically, never settable from a request body."
- Fixed by declaring `createdBy: String?` (nullable) in Prisma, then restoring the mandatory guarantee via CHECK constraint `<table>_created_by_required` (migration `20260812140740_created_by_optional_to_prisma`) on all 21 business tables except `User`/`UserProfile` (bootstrap admin has no creator; self-registration owns its own first profile).
- Prisma's schema differ ignores CHECK constraints, so this produces no drift between `schema.prisma` and the DB.
- Asserted in tests (`code-constraints.test.ts`): raw SQL insert with `createdBy = NULL` is rejected; exactly 21 tables carry the constraint.

#### Audit extension (from Phase 1, still active)

- `packages/db/src/audit-extension.ts` — Prisma client extension, stamps `createdBy`/`updatedBy` on every write by walking the DMMF for nested writes too. Uses `AsyncLocalStorage` (`actor-context.ts`, `withActor()`) so no service threads `userId` manually.
- **Gotcha discovered and documented**: Prisma query methods return a _lazy_ `PrismaPromise` — nothing executes until awaited. `withActor(actor, () => prisma.x.create(...))` (non-async arrow) loses the actor context because the actual query runs _after_ `storage.run()` has returned. Must write `withActor(actor, async () => prisma.x.create(...))`. Documented in a large comment on `withActor()` itself.

#### Seed script

- `packages/db/prisma/seed.ts` — idempotent (guards on `findFirst` against live rows, since natural keys are only partially unique so no `upsert`).
- Creates: 1 admin user (`admin@eztruckr.ph`, bootstrap — `createdBy: null`), 3 trucks, 4 crew members (mixed driver/helper eligibility, one driver has no license fields populated demonstrating nullable-until-driver-slot), 3 clients, 1 third-party broker, 4 routes, 7 expense categories (fuel/toll/food/parking/ferry/gate pass/miscellaneous), 2 unscoped `CommissionRule` rows (15% driver / 7.5% helper, `PERCENT_OF_BASE` method), and the `SystemSetting` singleton (`gasExpenseDeductionRate: 0.25` from schema default).
- Verified re-runnable (identical counts on second run).

### Tiered commission rates — added then fully reverted

- User asked "can commission rule reference computed fields?" → explained the base _is_ resolvable pre-multiplication, proposed `minCommissionableBase`/`maxCommissionableBase` half-open interval band.
- User said "support tiered commission rates" → implemented: two nullable Decimal columns, a Postgres `EXCLUDE USING gist` constraint (needs `btree_gist` extension) preventing ambiguous overlapping bands at the same role/scope/priority, 4 CHECK constraints (band ordering, non-negative, rate range, effective-window ordering), 12-case SQL verification script.
- User then said "revert tiered commission rate support" → fully reverted: schema fields removed, 2 migrations deleted, verification script deleted, seed guard reverted, README section removed. Required a `prisma migrate reset --force` (Prisma blocks destructive AI actions without recorded consent — user explicitly approved via `AskUserQuestion`). Verified zero residue (grep, DB inspection, re-seed, payout guards re-tested).
- **This entire feature does not exist in the current codebase.** Only mentioned here so a new session doesn't reinvent or get confused by any lingering references.

### Migration reset for the enum→smallint rewrite

- Converting Postgres enum columns to SMALLINT has no in-place cast path (`prisma migrate dev` refused: "No cast exists, the column would be dropped and recreated"). Required another explicit-consent `prisma migrate reset --force` (user chose "reset" over "hand-write cast migrations" via `AskUserQuestion`).
- Old 3-migration history deleted; squashed to a clean 4-migration chain:
  1. `20260812135836_init` — full schema, SMALLINT codes, no enum types.
  2. `20260812135900_code_constraints_and_comments` — CHECKs + COMMENTs for code columns, plus money/rate range CHECKs, plus soft-delete consistency CHECKs (`deletedAt`/`deletedBy` set together).
  3. `20260812135930_partial_uniques_and_payout_guards` — all partial unique indexes + the 5 payout triggers.
  4. `20260812140740_created_by_optional_to_prisma` — nullability fix + `_created_by_required` CHECKs.

A fifth was added in Phase 3:

5. `20260813000000_drop_commission_rate_fallback` — drops `SystemSetting.driverCommissionRate` / `helperCommissionRate`. **Hand-written, and the reason matters**: `system_setting_rate_ranges` is a single CHECK spanning all three rate columns, and Postgres drops a multi-column constraint entirely when any column it references goes. The migration drops and rebuilds it narrowed, or the `gasExpenseDeductionRate` bound would vanish silently. (`prisma migrate dev` also refuses to run non-interactively here, so hand-writing was necessary anyway.)

---

## Phase 3 — Auth and master data ✅

### Better Auth

- `apps/api/src/auth/auth.ts` builds the instance over the **existing** Phase 2 tables via `prismaAdapter`. The `user` table already matched Better Auth's own shape, so nothing was renamed; `UserProfile` remains the extension, holding presentation and contact detail.
- `role`, `isActive` and `crewMemberId` are declared as `user.additionalFields` with **`input: false`** — no request body can set them, at sign-up or update. Roles are assigned only by the admin-guarded users service, through Prisma.
- **Public sign-up is closed** by a `before` hook that throws when `ctx.path === '/sign-up/email' && ctx.request`. `ctx.request` is set only for HTTP-originated calls, so the admin service's in-process `auth.api.signUpEmail()` still works. Verified live: HTTP sign-up → 403, admin creation → 201.
- **Open question 6 resolved.** Better Auth's Prisma adapter uses `findFirst`, never `findUnique` (confirmed by reading `@better-auth/prisma-adapter`), so it makes no total-uniqueness assumption about email. The partial unique index works as-is: live duplicates rejected by the database, a deleted user's address reusable.
- Session resolution happens once per request in `SessionContextMiddleware`, which replaced `ActorContextMiddleware`. It sets `req.authUser` for the guards **and** opens the actor scope, so audit stamping and authorisation share one lookup. A soft-deleted user cannot authenticate for free — the soft-delete extension filters the lookup Better Auth performs.
- `lastLoginAt` is stamped by a `databaseHooks.session.create.after` hook using **raw SQL**, deliberately bypassing the audit extension: going through `prisma.user.update` would stamp `updatedBy` with the null actor and erase the real one every time someone logged in. Signing in is not an edit to the record.

### Guards

- Two global guards: `AuthenticatedGuard` (session required unless `@Public()`; deactivated accounts refused with a distinct message) and `RolesGuard`.
- **`RolesGuard` fails closed** — a route with no `@Roles(...)` is refused outright. "Role guards on every endpoint" is therefore structural, not a review checklist item.
- Policy declared once in `auth/role-policy.ts`. Roles are membership-tested, never ranked.
- Crew scoping: a CREW login may read its own `CrewMember` and nothing else, checked server-side against the session's `crewMemberId`.

### Master data

- Full CRUD for trucks, crew members, clients, third parties, routes, expense categories and commission rules, plus users and settings.
- **Reference-aware removal** (`master-data/removal.ts`): count what refers to the record first — referenced → `DEACTIVATED`, unreferenced → `SOFT_DELETED`, unreferenced expense category → `HARD_DELETED` (via `withHardDelete()`, the only place in the app that reaches it). The response names the outcome and the references; the UI reports it.
- Expense categories probe **billable expenses as well as liquidation lines**. The brief named only liquidation lines, but both FKs are `ON DELETE RESTRICT`, so a category referenced only by a billable expense would otherwise reach the database as a delete and fail there — a 409 the user cannot act on instead of the deactivation they wanted.
- Cross-field rules that cannot run on a PATCH fragment (driver needs a licence; a commission rule's amount column must match its method) are exported as plain predicates from `@eztruckr/types` and re-applied in the service to the patch merged onto the stored row.
- `PrismaExceptionFilter` translates P2002 → 409, P2003 → 409, P2025 → 404. Without it every database guarantee surfaced as a 500.

### Settings and auditing

- `GET/PATCH /api/settings` and `GET /api/settings/history` — **administrator only, read included**. The read was briefly open to every office role on the theory that a later screen would want the gas rate; the user rejected that, correctly: nothing consumed it, and the settings page was not role-gated, so any office role that typed the URL saw all three rates. When a commission screen needs the gas rate it should get a narrow endpoint returning just that value.
- Each change writes an `AuditLog` row **in the same transaction** as the update, capturing actor, timestamp, before and after. History is flattened to one entry per field.
- **Bug found and fixed during verification**: change detection compared `Decimal.toString()` against the input string, so `0.25` vs `0.2500` recorded a change that never happened. Now compared as `Prisma.Decimal` and rendered at the column's scale (`toFixed(4)`) everywhere.

### Web

- Login, role-aware app shell, seven master data screens driven by a declarative `ResourceSpec`, a bespoke users screen, the settings screen with its history, and a crew portal.
- **Bug found and fixed during verification**: a 403 left the UI on a spinner forever. TanStack Query had paused the retry (`fetchStatus: 'paused'`). Now 4xx is never retried and `networkMode: 'always'` prevents silent pausing — a paused query renders as pending with no error and no way out.
- Empty **required** fields submit as `""` rather than `null`, so the schema's own message ("must be at least 2 characters") appears instead of Zod's "expected string, received null"; `required` on the input catches it in the browser first.

---

## Current verified state (as of last check)

- **`pnpm run check`**: 14/14 tasks passing, uncached (format-check, lint, typecheck, test across all workspaces).
- **63 total tests**: 41 in `packages/db` (34 integration against real Postgres + 7 `relations.test.ts`), 22 in `apps/api` (`guards.test.ts` [11], `removal.test.ts` [7], `zod-validation.pipe.test.ts` [4]), plus the code-set unit tests in `packages/types`.
- Live verification against the **containerised** stack: unauthenticated read → 401, HTTP sign-up → 403, admin sign-in → 200, `/me` → 200, master data → 200. Browser-verified: login, dashboard, master data CRUD, removal reporting, settings history, crew portal, and a crew account refused on `/trucks` with the API's own message.
- Role matrix verified live: OPERATIONS can write trucks but not expense categories, users or settings; CREW can read only its own crew record; a deactivated user's existing session is refused on the next request.
- Database schema verified via direct SQL inspection: 0 enum types, 0 float columns, 0 naive timestamps, 23/23 tables with audit cols, 23/23 with soft-delete cols, 16 partial unique indexes, 10 code CHECKs, 21 `createdBy_required` CHECKs, 5 triggers, 1 full unique (payout link).
- `docker compose up -d --build` **re-verified after the Phase 2 schema rewrite**: all four containers healthy, `/api/health` returns `{"status":"ok"}` with database and storage both `up`, web renders the health card via TanStack Query, and UTC→Asia/Manila rendering is correct (14:24 UTC displayed as 10:24 PM).
- Schema invariants re-confirmed against the live database after rebuild: 0 enum types, 0 float columns, 0 naive timestamps, 23 soft-deletable business tables, 16 partial unique indexes, 21 `_created_by_required` CHECKs, 5 triggers.
- **Git initialized** — branch `main`, initial commit covering Phase 1 + Phase 2. No remote.

---

## Open questions / decisions flagged to user, not yet resolved

1. **Vehicles/trucks** were added by me (not in original brief's domain concepts list) — confirmed reasonable, no objection raised, but never explicitly confirmed as "correct."
2. **`Shipment.appliedTpcRate` semantics** (nullable = flat TPC amount agreed, set = percentage of gross) — my design choice, flagged for confirmation, no response yet.
3. ~~**`CommissionRule` vs `SystemSetting` fallback overlap**~~ — **RESOLVED (user decision).** `CommissionRule` is now the only source of truth for crew pay. `SystemSetting.driverCommissionRate` / `helperCommissionRate` were dropped (migration `20260813000000_drop_commission_rate_fallback`). The deciding argument: the fallback was strictly _less expressive_ than the thing it backed up — no effective window, no scope, no priority — so it could not answer "what was the helper rate in March?", the very question `CommissionRule.effectiveFrom` exists for. It also failed silently: an expired or mis-scoped rule would quietly pay the default. Nothing was lost, because the seeded unscoped priority-0 rules already carried the same values (0.1500 / 0.0750).
   - **`gasExpenseDeductionRate` stays on `SystemSetting`** — it is not per-role, so it has no rule equivalent, and putting it on a per-role rule would let the driver rule and helper rule disagree about the commissionable base of the same shipment. It is surfaced on **both** the settings screen and the commission rules screen via one shared component (`components/settings/gas-deduction-rate-card.tsx`) reading and writing the same row through the same query key. Surfaced twice, stored once.
   - **Consequence for Phase 4**: a shipment matching no rule must be an **error the engine raises**, not a number it invents.
4. **`CrewDeduction` partial recovery across multiple payout runs** — current model has one nullable `payoutLineId` + a `recovered` running total, which can't fully represent a debt clawed back across >1 run. Flagged; would need a join table if that's a real scenario.
5. ~~**1:1 relations modeled as 1:many**~~ — **RESOLVED (user decision).** Keep the partial-unique-backed arrays; added `liveOne()` / `liveOneOrThrow()` in `packages/db/src/relations.ts`, which assert-and-unwrap the single live row so call sites read as 1:1 without the schema lying. More than one survivor throws, because that means the partial unique index is gone. Used in `UsersService.currentUser`.
6. ~~**`user.email` only partially unique**~~ — **RESOLVED.** Better Auth's Prisma adapter uses `findFirst`, not `findUnique`, so it never assumes total uniqueness. No change needed.

### Still open after Phase 3

- Items 1, 2 and 4 above remain open. Item 3 is resolved (see above).
- **Two gaps opened by removing the fallback, both for Phase 4.** With no fallback, losing the baseline rule stops commissions computing — correctly, but nothing guards it today:
  1. `CommissionRulesService.remove()` passes `probes: []`, so soft-deleting or deactivating the **last live unscoped rule for a role** is frictionless. It needs a probe, or an explicit refusal.
  2. A baseline rule whose `effectiveTo` passes leaves the same hole with a timer on it. Rule coverage should be checked **proactively** — at dispatch, or as a dashboard warning — so a gap surfaces on a calm Tuesday rather than as a hard failure at month-end.
- **Crew scoping is only exercised on `CrewMember`** so far, because that is the only crew-facing resource Phase 3 built. The mechanism (`crewMemberId` on `RequestUser`, checked server-side) is in place for shipments and payouts in a later phase.
- **No API-level e2e tests.** Guards and the removal rule are unit-tested; wiring (Better Auth mounting, CORS ordering, session resolution) was verified live by hand rather than by an automated suite. A supertest harness would be worth adding before this grows.

---

## Tech stack confirmed in use (per brief, no substitutions)

Turborepo · Docker + docker compose · Next.js App Router + TypeScript · shadcn/ui + Tailwind v4 · TanStack Query · NestJS + TypeScript · Prisma · PostgreSQL 16 · currency.js (configured once in `packages/types/src/money/money.ts`, `{ symbol: '₱', precision: 2 }`) · MinIO (S3-compatible) · Prettier (root-level Turborepo task `//#format:check`).

**Better Auth 1.6.26** is now integrated (Phase 3). `express` was added as a direct API dependency, since `main.ts` mounts the auth handler and the body parsers itself.

---

## Development logins

Seeded on `docker compose up`. Development only.

| Email               | Password             | Role          |
| ------------------- | -------------------- | ------------- |
| `admin@eztruckr.ph` | `eztruckr-dev-admin` | Administrator |

`ops@eztruckr.ph` (Operations) and `driver@eztruckr.ph` (Crew, linked to a crew member) exist in the local database from this session's role testing but are **not** created by the seed — a fresh volume will have the administrator only.

---

## Suggested next steps for a new session

1. **The commission computation engine** — the obvious next phase, and everything it needs now exists: rate chain → gas deduction → commissionable base → driver/helper commission, with the worked example as a test fixture (₱18,000 gross → ₱1,822.50 driver / ₱911.25 helper). Resolving open question 3 (rule vs setting fallback) becomes unavoidable here.
2. **Shipments and liquidations** — the operational core, and the first real exercise of crew scoping beyond `CrewMember`.
3. **An API e2e harness** (supertest) covering the auth wiring, since that is the part currently verified only by hand.
4. Items 1, 2 and 4 of the open questions still want a decision from the user.
