# EZTruckr — Session Handoff

Trucking management system for a Philippine hauling company. Turborepo monorepo, built in phases. This document summarizes everything completed through **Phase 4** so a new session can continue without replaying history.

**Git.** Branch `main`, no remote configured.

| Commit           | What                                                    |
| ---------------- | ------------------------------------------------------- |
| `3af269a`        | Phase 1 foundation + Phase 2 data model                 |
| `61195ff`        | Handoff formatting, git init recorded                   |
| `fdd7a52`        | Phase 3 — auth, role guards, master data                |
| `56b371d`        | System settings made administrator-only, read included  |
| `b399139`        | CommissionRule becomes the only source of truth for pay |
| `8af6c76`        | Handoff brought current for a Phase 4 session           |
| _(this session)_ | Phase 4 — shipments, the money engine, FORMULA          |

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

**23 business tables + 3 Better Auth infra tables (`session` / `account` / `verification` — no audit columns, no soft delete) = 26 total**, verified by listing `information_schema.tables`. (`user` and `user_profile` are counted among the 23: they carry the full audit and soft-delete column set.)

Entities: `User`, `UserProfile`, `Truck`, `CrewMember`, `Client`, `ThirdParty`, `Route`, `ExpenseCategory`, `CommissionRule`, `SystemSetting`, `Shipment`, `Allowance`, `Liquidation`, `LiquidationLine`, `Receipt`, `BillableExpense`, `AdditionalCharge`, `CrewDeduction`, `Adjustment`, `Commission`, `PayoutRun`, `PayoutLine`, `AuditLog`.

#### No Postgres enums — SMALLINT codes instead

- **Zero** `enum` blocks in `schema.prisma`, zero native Postgres enum types (verified via `pg_type WHERE typtype='e'`).
- Every enumerated column is `Int @db.SmallInt`.
- Code sets declared **once each** in `packages/types/src/codes/*.ts` as frozen `as const` objects + derived union types + label maps + a `defineCodeSet()` helper providing `isValid`/`schema` (Zod).
- Code sets defined: `ShipmentStatus` (1-6), `LiquidationStatus` (1-3), `CrewRole` (1-2), `AdjustmentDirection` (1-2), `UserRole` (1-5), `CommissionMethod` (1-5, where 5=TIERED is **reserved/unimplemented** — `isImplementedCommissionMethod()` rejects it at the service layer, not the DB), and `PayoutRunStatus` (1-4, added beyond the brief because "PAID is terminal" needs a lifecycle).
  - ⚠️ **Two of these were corrected in Phase 4** and this line describes the Phase 2 state only. `ShipmentStatus` is now 1-7 (`PENDING_LIQUIDATION` had been wrongly omitted) and code 5 of `CommissionMethod` is `FORMULA`, not `TIERED`. See the Phase 4 section for the reasoning and the approval.
- **Codes are permanent**: never renumbered, never reused, append-only. Enforced by convention + `code-set.test.ts` pinning every value.
- **Order-dependent logic uses declared sequences, never raw number comparison** — e.g. `shipmentStatusAtLeast(candidate, reference)` looks up position in `SHIPMENT_STATUS_SEQUENCE`, not `candidate >= reference`.
- Each code column has a **CHECK constraint** (migration `20260812135900_code_constraints_and_comments`) listing valid codes explicitly (not `BETWEEN`, since codes aren't guaranteed contiguous) and a SQL `COMMENT ON COLUMN` decoding it.
- **Drift guard**: `code-constraints.test.ts` reads live CHECK constraint definitions out of `pg_constraint` and diffs them against the TypeScript code sets — the one unavoidable duplication (migrations are static SQL, can't import TS) is kept honest by this test.

#### Soft delete everywhere

- Every business table: nullable `deletedAt` (timestamptz) + `deletedBy` (FK to User).
- **No hard deletes by default.** Application-level enforcement: the soft-delete Prisma extension (`packages/db/src/soft-delete-extension.ts`) throws on `delete`/`deleteMany` unless explicitly permitted via `withHardDelete()`. Phase 2 used that escape only in tests; **Phase 3 gave it exactly one production caller** — removing an expense category nothing has been filed under (see "Master data" below). Everything else still soft-deletes at most.
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
- **The commission-rate fallback was removed** (see open question 3). `SystemSetting` now holds exactly one editable value: `gasExpenseDeductionRate`. `AUDITED_FIELDS` is down to that one entry, and the audit machinery around it is still worth having — it is the rate every commission is computed against.
- The gas rate is rendered by **one shared component**, `components/settings/gas-deduction-rate-card.tsx`, placed on both the settings screen and the commission rules screen. Both read and write the same row through the same TanStack Query key, so a change on either is immediately correct on the other. Surfaced twice, stored once. The card is administrator-only and returns `null` otherwise, so callers do not repeat the role check.
- Retired fields keep their labels in the settings history (`Driver commission rate (retired)`), so the audit trail reads as sentences rather than degrading into raw column names when a field is dropped.

### Web

- Login, role-aware app shell, seven master data screens driven by a declarative `ResourceSpec`, a bespoke users screen, the settings screen with its history, and a crew portal.
- **Bug found and fixed during verification**: a 403 left the UI on a spinner forever. TanStack Query had paused the retry (`fetchStatus: 'paused'`). Now 4xx is never retried and `networkMode: 'always'` prevents silent pausing — a paused query renders as pending with no error and no way out.
- Empty **required** fields submit as `""` rather than `null`, so the schema's own message ("must be at least 2 characters") appears instead of Zod's "expected string, received null"; `required` on the input catches it in the browser first.

---

## Phase 4 — Shipments and the money engine ✅

The commission engine, the shipment lifecycle, charges, and the screens over them.

### Two code-set corrections, approved before anything was built on them

Both were deviations from the brief introduced in Phase 2, and both collided with the
"codes are permanent, append only" rule. The user chose to correct rather than append,
on the reasoning that the rule protects **stored rows**, and the tables were empty
(verified: 0 shipments, 0 commissions, no rule using method 5).

| Set                | Was                    | Now                                           |
| ------------------ | ---------------------- | --------------------------------------------- |
| `ShipmentStatus`   | 5 LIQUIDATED, 6 CLOSED | 5 PENDING_LIQUIDATION, 6 LIQUIDATED, 7 CLOSED |
| `CommissionMethod` | 5 TIERED (reserved)    | 5 FORMULA                                     |

`PENDING_LIQUIDATION` had simply been omitted in Phase 2. `TIERED` was never in any
brief — it was a leftover from the tiered-rates feature that was implemented and then
fully reverted; the brief always named FORMULA at code 5.

**The rule is back in force.** Shipments exist now. Both code sets are frozen, and the
pinning tests in `code-set.test.ts` carry a comment explaining the one-time exception so
nobody reads it as precedent.

### The money engine

`apps/api/src/commission/` — pure, DB-free pieces plus one service that connects them:

| File                             | Owns                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| `commission-chain.ts`            | The rate chain and the commission chain, as arithmetic. Each step rounds.  |
| `commission-strategies.ts`       | All five methods as a dispatch table. Returns `{ effectiveRate, amount }`. |
| `rule-resolver.ts`               | Which rule wins, and the refusal when none does.                           |
| `formula-evaluator.ts`           | Walks a parsed formula against real values.                                |
| `rational.ts`                    | Exact BigInt rational arithmetic, used only by the evaluator.              |
| `commission.service.ts`          | Loads, computes, freezes. The only place that writes a commission.         |
| `commission-coverage.service.ts` | Proactive "will the next shipment be payable?" check.                      |

**Nothing else in the codebase multiplies a base by a rate.**

#### Why there is a BigInt rational module in a currency.js project

currency.js is configured once at precision 2, which is correct for the commission
chain — every step there is a stored value, so every step rounds. A **formula** is
different: it has no stored intermediates, and the brief says division "defines its own
precision" with one round at the end. Running those intermediates through a 2dp type
destroys them — the literal `0.075` alone becomes `0.08`.

So `rational.ts` walks the AST in exact fractions (no float anywhere) and rounds exactly
once, at the boundary, into money. Its tie rule is half-toward-+∞ **because that is what
`Math.round` does and therefore what currency.js does** — the two have to agree or
FORMULA and PERCENT_OF_BASE would disagree on the same figure. Asserted directly:
995.625 → 995.63 down both paths.

`decimal.js` was not used because it is not a dependency and `packages/types` cannot
import `@eztruckr/db` (wrong direction). Exact rationals need no dependency at all.

#### The FORMULA method, and why it is split across two packages

- **`packages/types/src/commission/formula-syntax.ts`** — catalog, tokenizer,
  recursive-descent parser, AST, `validateFormulaExpression`. Pure syntax: no money, no
  shipment.
- **`apps/api/src/commission/formula-evaluator.ts`** — walks the AST against real values.

The split is structural, not stylistic. "All financial computation lives in the backend"
holds because there is nothing in the shared package the web app _could_ compute a peso
figure with, while the authoring screen can still check an expression as it is typed.

Security properties, all asserted:

- No `eval`, `Function`, `vm`, or third-party evaluator. Hand-written parser, hand-walked AST.
- Node types are exactly: number literal, catalog field, `+ - * /`, unary minus, parens.
- Validated **on save** — a rule that failed to parse is never persisted — and re-parsed
  at computation, because the column is mutable and re-parsing costs microseconds.
- Bounded: 500 characters, 32 nesting levels, so a pathological expression cannot
  overflow the stack.
- Divide-by-zero and a negative result are errors surfaced to the user, never clamped.

#### Rule resolution has no fallback

Candidates are active, undeleted, role-matching, in a half-open `[effectiveFrom,
effectiveTo)` window, scope-matching. Winner by specificity (client+route ▸ client ▸
route ▸ unscoped), then priority, then latest `effectiveFrom`, then id.

If nothing matches the engine **raises a 422 naming the role and the date**, per the
Phase 3 decision. Verified live.

The date tested is `dispatchedAt` (falling back to `createdAt`): the rate in force when
the crew set off, not when the paperwork caught up.

### Later schema work in the same phase

Two follow-ups, each on an explicit decision rather than as part of the original build.
Both are described under the resolved open questions below:

- `20260812181020_split_gas_rate_override_from_applied` — the gas rate becomes an input
  column and an output column, so override-ness is structural.
- `20260812192500_crew_deduction_recovery_join_table` — deduction recovery becomes
  divisible across payout runs. **This is the 24th business table**, so the counts in the
  Phase 2 section above (23 business, 26 total) are the Phase 2 figures; it is now 24 and 27.

### Schema changes (migration `20260812170815_phase4_formula_and_status_codes`)

- `CommissionRule.params` JSON, with a CHECK: FORMULA needs a non-empty
  `params->>'expression'`; every other method must leave it null.
- `Commission.appliedFormulaExpression` + `appliedFormulaFields`, with a CHECK tying both
  to `appliedMethod = 5` and forbidding them elsewhere. A formula is the one method whose
  logic lives in editable data, so without these the amount stops being reproducible the
  moment someone edits the rule.
- **`Commission.appliedRate` widened to `Decimal(9,4)` and made nullable.** It was
  `(5,4) NOT NULL` bounded to `[0,1]`, which is right for a stored percentage and wrong
  for what it now holds. For the two percent methods it is still the rule's rate and
  still an operand. For fixed and formula methods no rate produced the amount, so it is
  **derived for reporting** — and a flat fee on a small backhaul is legitimately several
  hundred percent of its base. Null means "no meaningful figure" (zero denominator);
  storing 0 would have read as "earned nothing". Two CHECKs keep it honest: the tight
  `[0,1]` bound still applies to methods 1 and 4, and those two may not leave it null.
- `shipment_status_code_valid` widened to 1–7, with the COMMENT rewritten.

### Shipment lifecycle

`DRAFT → DISPATCHED → IN_TRANSIT → DELIVERED → PENDING_LIQUIDATION → LIQUIDATED → CLOSED`

Two steps are not requestable, and the transition table says so:

- **DELIVERED is written through to PENDING_LIQUIDATION in the same statement.** Asking
  for status 4 stores 5. A delivered trip is never left in a state nobody queries.
- **LIQUIDATED is earned, not requested** — it needs an approved liquidation _and_
  computed commissions, and the service applies it when the second of the two lands.
  Phase 4 owns the commissions half; Phase 5 will own the other.

Forward only. Nothing reopens a shipment, because the frozen rates and computed
commissions behind it have no defined behaviour in reverse.

Guard rails: dispatch needs a driver and a truck; **close needs computed commissions and,
if any allowance was advanced, an approved liquidation**.

### The bug worth knowing about: computed vs paid

First cut locked charges, crew and the gas override the moment `commissionsComputedAt`
was set. That is a dead end — a charge discovered late is exactly what a recomputation
exists to absorb, and the user could neither fix the charge nor make the recompute say
anything different.

The line that actually matters is **paid**, not computed. `assertNothingPaid` now guards
all three, and a computed-but-unpaid commission goes stale instead of blocking.
`Shipment.commissionsStale` is **derived** by comparing `commissionsComputedAt` against
charge `updatedAt` — no column, because a stored flag is one more thing that can be
wrong. It is on the detail response only; the list does not pay for the extra queries.

A second, related bug: `resolveGasDeductionRate` read the frozen
`appliedGasDeductionRate` on recompute, so a corrected system default could never reach a
shipment. The first fix branched on `gasRateOverrideReason`; **the column was then split
into an input and an output** (see resolved question 7), so resolution is now
`gasRateOverride ?? systemDefault` and the distinction is structural rather than inferred
from a reason string. Freezing still holds — `appliedGasDeductionRate` only moves when
somebody explicitly asks for recomputation.

### The two coverage gaps from Phase 3, closed

1. **Removing the last rule for a role is refused** (409), not reported as an outcome —
   unlike deactivate-instead-of-delete, no lesser action leaves the system working. The
   check also fires when an update sets `isActive: false`.
2. **`CommissionCoverageService`** reports gaps that exist now and gaps opening within a
   horizon (default 30 days), surfaced as a banner on the commission rules screen. It
   only checks **unscoped** baselines — a scoped rule covers one client or route, and the
   combinations nobody thought of are not enumerable from the table.

The division of labour is deliberate and was verified live: the coarse removal guard
stops the unambiguously fatal case; the coverage report catches the expiry the coarse
check cannot see; the engine's refusal remains the thing that guarantees correctness.

### API surface added

| Route                                                                              | Roles                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET/POST /shipments`, `PATCH /shipments/:id`                                      | read: office + crew (scoped) · write: ADMIN/OPS            |
| `PATCH /shipments/:id/crew`                                                        | ADMIN/OPS                                                  |
| `PATCH /shipments/:id/status`                                                      | union, then per-target from `ROLES_BY_TRANSITION`          |
| `GET/PATCH /shipments/:id/gas-rate`                                                | read: office · write: ADMIN/ACCOUNTING                     |
| `GET/POST/PATCH/DELETE /shipments/:id/billable-expenses` and `/additional-charges` | read: office · write: ADMIN/ACCOUNTING                     |
| `GET/POST /shipments/:id/commissions`                                              | read: office + crew (own only) · compute: ADMIN/ACCOUNTING |
| `GET /commissions/crew/:crewMemberId`                                              | office; crew may only ask about itself                     |
| `GET /commissions/rule-coverage`                                                   | office                                                     |
| `GET /commissions/formula-fields`                                                  | ADMIN/ACCOUNTING                                           |

`ROLES_BY_TRANSITION` exists because the route guard cannot see the request body. The
`@Roles` on `/status` is the union of everyone who may move a shipment at all; the
controller then applies the per-target policy, so operations cannot close a trip and
accounting cannot dispatch one.

### Crew scoping, verified end to end

A crew session's shipment list filter is **overwritten**, not validated — there is no
query string that widens it. Detail reads are refused unless they worked the trip, and
commissions on a shared trip are filtered to their own row. Verified live: 1 shipment
visible, own detail 200, colleague's commissions 403, all writes 403.

---

## Current verified state (end of Phase 4)

- **`pnpm run check`**: 14/14 tasks passing, uncached.
- **195 tests**, all passing (was 82):

  | Workspace        | Count | Added in Phase 4                                                                                              |
  | ---------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
  | `packages/types` | 67    | `formula-syntax` [47] — mostly what the parser REFUSES                                                        |
  | `packages/db`    | 49    | drift guard confirms status codes 1–7; 3 assert the gas-override pairing; 5 the deduction-recovery join table |
  | `apps/api`       | 79    | `commission-engine` [38], `formula-evaluator` [19]                                                            |

- **The brief's required assertions pass, in unit tests and again live:**
  - `netRate 16200`, no commissionable charges, gas 25% → gasDeduction **4050.00**, base
    **12150.00**, driver **1822.50**, helper **911.25**
  - with a 1500 commissionable charge → base **13275.00**, driver **1991.25**, helper
    **995.63** (995.625 half-up — asserted explicitly, both through
    PERCENT_OF_BASE and through an equivalent FORMULA)

- **Live, against the containerised stack**, in order: created SH-2026-0001 at 18,000
  gross / 10% TPC → net 16,200; refused a helper in the driver slot and the same person
  in both slots; dispatched → in transit → **asked for DELIVERED (4) and got
  PENDING_LIQUIDATION (5)**; added the extra drop fee; computed; flipped the fee to
  commissionable and saw `commissionsStale: true`; recomputed to 995.63; overrode the gas
  rate to 30% with a reason (and was refused without one); created a client-scoped
  FORMULA rule and watched it beat the unscoped baseline for the driver only; inserted an
  approved liquidation and watched computation advance the shipment to LIQUIDATED; closed
  it; was refused on closing it twice.
- **Formula injection refused at the API boundary**, each with a specific message:
  `net_rate; process.exit(1)`, `require("fs")`, `net_rate.constructor`, `` `${net_rate}` ``,
  `net_rate ** 2`, `globalThis`, `net_rate = 1`, and an unknown field.
- **The no-fallback path proved live**: with only an expired helper baseline left, the
  coverage report warned first, and computing then failed 422 with a message naming the
  role, the date and the fix.
- **Browser-verified**: the shipment list, the detail page rendering the rate chain as a
  worksheet, the FORMULA commission showing its frozen expression and resolved field
  values, the gas override showing 30% against the 25% system default with its reason,
  and both charge lists.
- `prisma migrate status`: 8 migrations applied, no drift. Seed still idempotent.
- **The migration chain was replayed from scratch** into a throwaway database
  (`eztruckr_migrationtest`, since dropped) — worth doing because Phase 4's migrations are
  largely hand-written SQL. All eight applied cleanly and the invariants held on a virgin
  schema: 0 enum types, 0 float columns, 0 naive timestamps, 27 tables, 9 payout
  triggers, 17 partial unique indexes, 22 `_created_by_required` CHECKs,
  `shipment_status_code_valid` accepting 1–7, and `commission.appliedRate` as
  `numeric(9,4)`.

### Test data left in the development database

Phase 4 verification created rows in the local Postgres. A fresh volume is unaffected.

- `SH-2026-0001`, closed, with commissions and one additional charge, and `SH-2026-0002`,
  pending liquidation — used to prove the gas-rate split end to end.
- A client-scoped FORMULA rule (`Northport driver formula`) and a replacement
  `Default helper commission` rule — the seeded original was soft-deleted while proving
  the removal guard.
- **One hand-inserted `liquidation` row (`itest-liq-1`)**, written with raw SQL to
  exercise the LIQUIDATED transition, since Phase 5 owns liquidation. It has
  `totalLiquidated = 0` and no lines. Delete it or reset the volume before building
  Phase 5 against it.
- `driver@eztruckr.ph`'s password was reset to `eztruckr-dev-crew` to test crew scoping.

---

## Tech stack confirmed in use (per brief, no substitutions)

Turborepo · Docker + docker compose · Next.js App Router + TypeScript · shadcn/ui + Tailwind v4 · TanStack Query · NestJS + TypeScript · Prisma · PostgreSQL 16 · currency.js (configured once in `packages/types/src/money/money.ts`, `{ symbol: '₱', precision: 2 }`) · MinIO (S3-compatible) · Prettier (root-level Turborepo task `//#format:check`) · Better Auth 1.6.26.

**No dependency was added in Phase 4.** The exact arithmetic the formula evaluator needs
is a ~140-line BigInt rational module rather than a library, so currency.js remains the
only money dependency and the boundary rule is unchanged.

---

## Development logins

Seeded on `docker compose up`. Development only.

| Email               | Password             | Role          |
| ------------------- | -------------------- | ------------- |
| `admin@eztruckr.ph` | `eztruckr-dev-admin` | Administrator |

`ops@eztruckr.ph` (Operations) and `driver@eztruckr.ph` (Crew, linked to Joel Bautista,
password reset to `eztruckr-dev-crew` during Phase 4 testing) exist in the local database
but are **not** created by the seed — a fresh volume has the administrator only.

---

## Phase 5 — what a new session needs to know

Phase 5 is allowance, liquidation and receipts. Everything it depends on exists.

### The contract Phase 4 leaves for it

- **`Shipment` reaches LIQUIDATED when two things are true**: an approved liquidation
  exists, and commissions are computed. `CommissionService.statusAfterComputing` applies
  the move from the commission side. **Phase 5 must apply it from the other side** — when
  a liquidation reaches APPROVED on a shipment whose commissions are already computed.
  The predicate is deliberately symmetric; do not duplicate the status logic, lift it.
- **The allowance is not a P&L cost.** It is a receivable from the crew, cleared by the
  liquidation, and only liquidated actual expenses are recognised as cost. The close
  guard already refuses to close a shipment with allowances and no approved liquidation.
- **The gas deduction is not a cost line either.** Actual fuel is recognised through the
  liquidation. Counting it in the P&L as well would double it. Both traps are documented
  in `commission-chain.ts` and in the formula field catalog.
- **Charges lock on `paid`, not on `computed`** — see the Phase 4 note above. Apply the
  same rule to liquidation lines rather than inventing a second one.

### Still worth doing

- **An API e2e harness (supertest).** Still absent. Phase 4's verification was thorough
  but manual: a Python script driving the containerised stack, not something CI re-runs.
  The commission engine's _arithmetic_ is well covered by unit tests; its _wiring_ —
  status guards, role policy per transition, crew scoping — is only proved by hand.
  This is now the biggest gap in the suite.
- **`CommissionService.computeForShipment` has no unit test**, only live verification,
  because it needs Prisma. The pure pieces around it are covered; the orchestration is
  not. A test client against the real Postgres (as `packages/db` does) would close it.
- The commission row does **not** record which rule produced it. That was deliberate —
  the brief specifies what Commission stores, and adding an FK would also change
  `removeRecord` semantics for rules — but "which rule paid this?" is answered today only
  by inference from the frozen rate and method. Worth revisiting if audit asks.

---

## Open questions / decisions flagged to user

1. **Vehicles/trucks** were added by me (not in the original brief's domain concepts
   list) — never explicitly confirmed as correct.
2. ~~**`Shipment.appliedTpcRate` semantics**~~ — **RESOLVED by implementation in Phase 4,
   still worth a nod from you.** A broker cut is entered as _either_ a percentage of
   gross _or_ a flat amount, never both; `appliedTpcRate` is set for the former and null
   for the latter. This is the design that was flagged in Phase 3; Phase 4 built it,
   enforced the exclusivity in the schema (`hasUnambiguousTpc`) and refused a TPC on a
   shipment with no broker at all. A cut larger than the gross rate is also refused,
   since a negative net rate would poison every figure downstream.
3. ~~**`CommissionRule` vs `SystemSetting` fallback overlap**~~ — **RESOLVED (Phase 3).**
   `CommissionRule` is the only source of truth for crew pay. Phase 4 honoured it: a
   shipment matching no rule raises, and the two gaps this opened are now closed.
4. ~~**`CrewDeduction` partial recovery across multiple payout runs**~~ — **RESOLVED
   (user decision): added the join table.** Migration
   `20260812192500_crew_deduction_recovery_join_table`.

   A commission is indivisible, so one link with a full unique models it. A deduction is
   **divisible** — a ₱9,000 damage claim against someone earning ₱1,800 a fortnight comes
   back a slice at a time — and it was being modelled with a single `payoutLineId` PLUS a
   `recovered` running total, which is two incompatible designs at once. The link was
   repointed every run, so all but the last recovery vanished and an earlier voucher
   could no longer be itemised; the running total had no record of what made it up; and
   nothing stopped it being incremented twice, recovering a debt twice and
   short-changing the crew member.

   Now `crew_deduction_recovery` holds one row per slice (which debt, which line, how
   much). `payoutLineId`, `recovered` and `isSettled` are **dropped** rather than kept as
   a cache — same reasoning as the SystemSetting rate fallback, two places holding one
   number where the weaker wins silently. The outstanding balance is the debt less the
   sum of live recoveries.

   Guarantees, all asserted: a partial-unique on (deduction, line) so one line cannot
   take two slices of one debt; `amount > 0`; a constraint trigger refusing
   over-recovery (a CHECK cannot span rows); and the **same idempotency family as
   commissions** — once the run is PAID the recovery cannot be altered, soft-deleted or
   hard-deleted. That last one was previously absent on this side of the ledger
   entirely. `eztruckr_commission_is_paid` is reused rather than duplicated, so PAID has
   one definition in SQL.

5. ~~**1:1 relations modeled as 1:many**~~ — **RESOLVED (Phase 3).** `liveOne()` /
   `liveOneOrThrow()` unwrap the single live row.
6. ~~**`user.email` only partially unique**~~ — **RESOLVED (Phase 3).**

### New in Phase 4, worth your confirmation

7. ~~**The gas override reuses `appliedGasDeductionRate`.**~~ — **RESOLVED (user
   decision): split into an input and an output.** Migration
   `20260812181020_split_gas_rate_override_from_applied`.

   The single column held both the rate a person asked for and the rate the engine
   froze, with `gasRateOverrideReason` left to tell them apart. That decoded correctly
   but only by convention — **no CHECK could enforce it, because Postgres had the same
   missing information** — and it made recomputation depend on a reason _string_ being
   present. Any future write path setting a rate without a reason would have turned an
   override into a "frozen default" and had it overwritten on the next recompute, paying
   the crew a different figure with nothing raising.

   Now: `gasRateOverride` (input, what somebody asked for) · `gasRateOverrideReason`
   (why) · `appliedGasDeductionRate` (output, what the engine froze — like every other
   `applied*` column, written only by the engine). Resolution collapses to
   `gasRateOverride ?? systemDefault` with no branching on the reason, and
   `shipment_gas_rate_override_needs_reason` enforces the pairing **in both directions**
   against raw SQL, not just at the endpoint that validates it. Backfilled from the
   reason column; the one existing shipment came through correctly.

   `GET /shipments/:id/gas-rate` now returns `systemDefault`, `override`, `effective`
   (what the next computation will use) and `frozen` (what the last one did) as separate
   fields, because the last two diverge whenever the override or the system default
   changes after computing. The card shows both and prompts a recompute when they differ.

8. **`Commission.appliedRate` is nullable and no longer bounded to `[0,1]` for the fixed
   and formula methods.** See the schema section above. The alternative was refusing to
   record a legitimate flat fee on a zero-rated backhaul because the _reporting_ rate is
   undefined, which seemed worse.
9. **Dropping `isSettled` means a write-off has nowhere to live.** Settlement is now
   derived (recovered = amount), so "we forgave the rest of the tyre debt" cannot be
   expressed. That is a different concept from a recovery and wants its own
   representation — a write-off amount or a status — rather than a boolean that can
   disagree with the arithmetic. Flagging it for Phase 6 rather than guessing now.
10. **Charges stay editable after commissions are computed, until something is paid.**
    The shipment then reports `commissionsStale` and the UI prompts a recompute. The
    stricter reading — lock at computation — was tried first and is a dead end.
