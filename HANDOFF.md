# EZTruckr — Session Handoff

Trucking management system for a Philippine hauling company. Turborepo monorepo, built in phases. This document summarizes everything completed through **Phase 2** so a new session can continue without replaying history.

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

---

## Current verified state (as of last check)

- **`pnpm run check`**: 14/14 tasks passing (format-check, lint, typecheck, test across all workspaces).
- **57 total tests**: 34 DB integration tests (real Postgres, 3 files: `payout-idempotency.test.ts` [7], `soft-delete.test.ts` [13], `code-constraints.test.ts` [14]), 19 code-set unit tests, 4 API unit tests (Zod pipe stripping).
- Database schema verified via direct SQL inspection: 0 enum types, 0 float columns, 0 naive timestamps, 23/23 tables with audit cols, 23/23 with soft-delete cols, 16 partial unique indexes, 10 code CHECKs, 21 `createdBy_required` CHECKs, 5 triggers, 1 full unique (payout link).
- `docker compose up -d --build` **re-verified after the Phase 2 schema rewrite**: all four containers healthy, `/api/health` returns `{"status":"ok"}` with database and storage both `up`, web renders the health card via TanStack Query, and UTC→Asia/Manila rendering is correct (14:24 UTC displayed as 10:24 PM).
- Schema invariants re-confirmed against the live database after rebuild: 0 enum types, 0 float columns, 0 naive timestamps, 23 soft-deletable business tables, 16 partial unique indexes, 21 `_created_by_required` CHECKs, 5 triggers.
- **Git initialized** — branch `main`, initial commit covering Phase 1 + Phase 2. No remote.

---

## Open questions / decisions flagged to user, not yet resolved

1. **Vehicles/trucks** were added by me (not in original brief's domain concepts list) — confirmed reasonable, no objection raised, but never explicitly confirmed as "correct."
2. **`Shipment.appliedTpcRate` semantics** (nullable = flat TPC amount agreed, set = percentage of gross) — my design choice, flagged for confirmation, no response yet.
3. **`CommissionRule` vs `SystemSetting` fallback overlap** — two sources of truth for driver/helper rates (rule table is authoritative, system setting is fallback-when-no-rule-matches). Flagged as a smell, not resolved.
4. **`CrewDeduction` partial recovery across multiple payout runs** — current model has one nullable `payoutLineId` + a `recovered` running total, which can't fully represent a debt clawed back across >1 run. Flagged; would need a join table if that's a real scenario.
5. **1:1 relations modeled as 1:many** (see soft-delete section above) — `Liquidation`, `UserProfile`, `CrewMember.logins`, `Receipt`'s backlinks — because Prisma can't express partial-unique-backed one-to-one. Flagged as a one-line-per-model fix if the user wants true 1:1 typing back (would need to drop the partial-unique-on-delete benefit for those specific tables, or find another way).
6. **`user.email` only partially unique** — a deleted user's email can be reused by a new user. Flagged as a Phase 3 risk: Better Auth's adapter may assume email uniqueness is total; may need reconsidering when auth is wired up.

---

## Tech stack confirmed in use (per brief, no substitutions)

Turborepo · Docker + docker compose · Next.js App Router + TypeScript · shadcn/ui + Tailwind v4 · TanStack Query · NestJS + TypeScript · Prisma · PostgreSQL 16 · currency.js (configured once in `packages/types/src/money/money.ts`, `{ symbol: '₱', precision: 2 }`) · MinIO (S3-compatible) · Prettier (root-level Turborepo task `//#format:check`).

**Not yet integrated**: Better Auth (Phase 1/2 apps have no real auth — `ActorContextMiddleware` currently resolves `userId` as always-null with a `TODO(phase-2)` comment that's now stale/should say phase-3).

---

## Suggested next steps for a new session

1. `git init` + initial commit — very overdue, flagged multiple times.
2. Fresh `docker compose up -d --build` smoke test — schema changed substantially since Phase 1's last verified boot.
3. Resolve the 6 open questions above, or explicitly defer them.
4. Phase 3 candidates per the original phased plan: Better Auth wiring + role/crew-scoping middleware, the commission computation engine (rate chain → gas deduction → commissionable base → driver/helper commission, using the worked example as a test fixture: ₱18,000 gross → ₱1,822.50 driver / ₱911.25 helper), and/or the NestJS API surface (controllers/services/DTOs) for the domain model that Phase 2 only modeled at the DB layer.
