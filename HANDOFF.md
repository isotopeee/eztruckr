# EZTruckr — Session Handoff

Trucking management system for a Philippine hauling company. Turborepo monorepo, built in phases. This document summarizes everything completed through **Phase 5** so a new session can continue without replaying history.

**Git.** Branch `main`, no remote configured.

| Commit    | What                                                       |
| --------- | ---------------------------------------------------------- |
| `3af269a` | Phase 1 foundation + Phase 2 data model                    |
| `61195ff` | Handoff formatting, git init recorded                      |
| `fdd7a52` | Phase 3 — auth, role guards, master data                   |
| `56b371d` | System settings made administrator-only, read included     |
| `b399139` | CommissionRule becomes the only source of truth for pay    |
| `8af9c76` | Handoff brought current for a Phase 4 session              |
| `7bf90f7` | **Phase 4** — shipments, the money engine, FORMULA         |
| `eaa1405` | Gas rate override split from the frozen applied rate       |
| `d92c56a` | Crew deductions recovered in slices across payout runs     |
| `d872cd4` | Write-off decision recorded, question list closed          |
| `a138387` | Commissions record which rule produced them                |
| `25c9c5c` | Handoff brought current for a Phase 5 session              |
| `d5405ad` | **Phase 5** — allowance, liquidation, receipts, settlement |

`eaa1405` through `a138387` are Phase 4 follow-ups, each made on an explicit decision
after the phase was first reported. They are not loose ends — see the decision record
below.

---

## Repository layout (as built)

```
eztruckr/
├─ apps/
│  ├─ web/          # Next.js 15 App Router, Tailwind v4, shadcn/ui, TanStack Query
│  └─ api/          # NestJS 11, health check, Zod validation pipe
├─ packages/
│  ├─ db/           # Prisma schema (29 domain tables), migrations, audit + soft-delete extensions
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

Three follow-ups, each on an explicit decision rather than as part of the original build.
All three are described under the decision record below:

- `20260812181020_split_gas_rate_override_from_applied` — the gas rate becomes an input
  column and an output column, so override-ness is structural.
- `20260812192500_crew_deduction_recovery_join_table` — deduction recovery becomes
  divisible across payout runs. **This is the 24th business table**, so the counts in the
  Phase 2 section above (23 business, 26 total) are the Phase 2 figures; it is now 24 and 27.
- `20260812203000_commission_records_its_rule` — `Commission.appliedRuleId` +
  `appliedRuleName`, frozen as a pair. **This changed removal semantics for commission
  rules**: a rule that has paid anything is now DEACTIVATED rather than soft-deleted,
  because history holds a link to it.

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

## Phase 5 — Allowance, liquidation, and receipts ✅

The cash trail of a trip: money out, what it was spent on, what came back.

### Four records, and why there are four

| Record               | Answers                                          |
| -------------------- | ------------------------------------------------ |
| `Allowance`          | what was released, when, how, and by whom        |
| `Liquidation`        | what it was spent on, and whether that is agreed |
| `LiquidationHistory` | who submitted or returned it, when, and why      |
| `Settlement`         | whether the leftover cash ever came back         |

The last one is the whole point of the phase. An approved liquidation says the spending
was accounted for and says **nothing** about the change in the driver's pocket. Inferring
one from the other reports a trip as clear while the crew still hold ₱1,500, so the
"allowances outstanding" alert reads `settlement.status` directly and never walks the
liquidation.

### `Allowance` is one row per release

Many per shipment, never one editable figure. A trip carries an initial advance and
whatever the road demands — a ferry queue, a re-weighing fee — and each release is its
own row with its own date, mode, reference, attachment and releaser. There is
deliberately no allowance column on `Shipment` for a second release to overwrite.

- `disbursementMode` (cash / bank transfer / e-wallet) is required; `referenceNumber` and
  the attachment stay **optional for every mode**, including transfers. A required
  reference is answered with "N/A", which looks like evidence and is not.
- `releasedBy` is a User FK distinct from `createdBy`: a supervisor hands cash over in the
  yard and a clerk records it that afternoon, and the voucher has to name the first.
- The route's `standardAllowance` (new column) prefills the **first** release only. A
  top-up is whatever the road cost; offering the standard figure again would suggest a
  number nobody meant. Nothing downstream reads it — variance is measured against what was
  actually released.
- `shipment.totalAdvanced` is summed on the detail response, like `commissionsStale`.

### The liquidation lifecycle

`PENDING → SUBMITTED → APPROVED`, and two reasoned moves backwards.

- **Created at PENDING when the shipment is marked delivered**, in the same statement.
  Before this, "the crew still owe us paperwork" was the absence of a row, which no query
  can filter on. `ShipmentsService` does it through the plain function in
  `liquidation/pending-liquidation.ts` — a DI cycle for one create was not worth it.
- **`submittedAt` became nullable.** It was `NOT NULL DEFAULT now()`, which asserted every
  liquidation had been submitted the instant it came into existence.
- **Returning is not a status.** Accounting returns with a required reason and the row goes
  back to PENDING, which already means "with the crew". A `RETURNED` state would behave
  identically to PENDING in every query, guard and screen.
- **`LiquidationHistory` is what tells them apart** — append-only, one row per submission
  and per return, with actor, timestamp and (for returns) reason. A CHECK ties the reason
  to the action. The crew portal shows the latest return reason; the dashboard's "returned
  for correction" filter is `PENDING` with prior history, exposed as
  `GET /liquidations?returnedOnly=true` so the definition lives in one place.
- **Approval is the lock.** No FINALIZED state. An approved liquidation may only move by
  being explicitly reversed, with a reason written to `AuditLog` — and the reversal clears
  `approvedAt`/`approvedBy`, because a row sitting at SUBMITTED while naming an approver is
  a claim the audit trail then has to argue with.

### Costs are recognised, never posted

`recognisedCost` is **derived from the status** on every read: `totalLiquidated` at
APPROVED, `0.00` everywhere else. That is what makes the brief's hardest requirement true
by construction rather than by care — return → resubmit → approve cannot post two sets of
costs, because nothing is ever posted. There is one live liquidation per shipment and it
either is approved or is not. A `posted` flag or ledger rows written on approval would be
a second copy of the same fact, needing a compensating entry on every reversal.

### Settlement, and the one direction a payout can recover

One record per shipment, created at approval with the frozen variance. With an advance and
two top-ups there is no honest way to say which release a returned ₱800 came from, so
nothing tries.

- Zero variance settles on the spot — otherwise a trip sits on the alert forever with
  nothing to clear it.
- `CARRIED_TO_PAYOUT` creates an **ordinary `CrewDeduction`**. That table already recovers
  in slices, already refuses to over-recover, and already freezes a recovery once its run
  is PAID; a parallel mechanism would be a weaker copy of all three.
- **Only a positive variance can be carried.** Money the company owes the crew is handed
  over, not deducted, and a payout run has nothing to recover from it.
- **The crew member is asked for, never guessed.** The settlement belongs to the trip; a
  deduction has to name a person, and the system does not know which of the driver and the
  helper the company holds responsible.
- `SettlementService.clearRecoveredCarryovers(actorId)` flips a carried settlement to
  SETTLED once its debt is fully recovered by runs marked PAID. **Phase 6 calls this when
  it marks a run Paid** — it is written here, with the settlement rules, rather than left
  for the payout code to reinvent.

### The LIQUIDATED predicate, lifted into one place

`shipmentStatusAfterLiquidationMilestone()` in `@eztruckr/types` is now the whole rule, and
both `CommissionService` and `LiquidationService` call it. It also runs **backwards**:
reversing an approval retracts one of the two facts, and a shipment left at LIQUIDATED with
no approved liquidation would sail through the close guard. That is the one backward move
in the shipment workflow; it is derived rather than requested, and it is refused outright
once the shipment is CLOSED.

### Receipts

One `Receipt` table and one upload path for every attachment — liquidation receipts, proof
of a release, proof of a settlement.

- **Upload and attach are separate steps.** The file goes up first and comes back as an id.
  Doing both in one request means a failed validation has already put bytes in the bucket,
  and a retry uploads them twice.
- **The bytes are served back through the API**, not by a presigned link. A presigned URL is
  a bearer token that outlives the request and travels outside `RolesGuard`, and a receipt
  is exactly the sort of thing one crew member may see and their colleague may not. Crew
  reads are scoped to trips they worked (or a receipt they uploaded and have not attached
  yet). It also keeps `@aws-sdk/s3-request-presigner` out of the dependency list.
- The object key is generated server-side and never leaves the API. A filename from a
  browser is attacker-controlled text.
- Allow-list of MIME types (images + PDF), 10 MB, enforced by multer while streaming **and**
  again in the service.

### Code sets: one appended, one retired

`LiquidationStatus` shipped in Phase 2 as SUBMITTED 1 / APPROVED 2 / FINALIZED 3, before
this lifecycle was specified. PENDING was **appended at 4**, not slotted in at 1 — even
though the table was empty and a renumber would have been safe. Nothing in this codebase
reads order from the number, so a renumber buys a tidier constant and spends the one rule
that keeps stored rows honest. Code 3 is **retired**: withdrawn, never reused, listed in
`RETIRED_LIQUIDATION_STATUS_CODES` and pinned by a test so the next code appended is 5.

New sets: `LiquidationHistoryAction` (SUBMITTED 1, RETURNED 2), `DisbursementMode`
(CASH 1, BANK_TRANSFER 2, EWALLET 3 — one vocabulary for money moving in both directions),
`SettlementStatus` (OUTSTANDING 1, SETTLED 2, CARRIED_TO_PAYOUT 3).

### Migration `20260813015610_phase5_allowance_liquidation_settlement`

Two new tables (**26 business tables now**), `route.standardAllowance`, the allowance
columns, the liquidation lifecycle changes, and the constraints that make the rules
structural rather than conventional:

- `liquidation_history_reason_matches_action` — a reason is required on a return and
  forbidden on a submission, expressible only because the action is its own column.
- `liquidation_approved_at_matches_status` and `liquidation_submitted_at_matches_status`.
- `settlement_movement_matches_status` — a settled variance names how it moved, unless
  there was nothing to move (zero) or it moved as a payroll deduction rather than as cash.
- `settlement_carry_needs_deduction` + `settlement_deduction_only_when_carried` — two
  implications rather than an equivalence, because the deduction link **outlives** the
  CARRIED_TO_PAYOUT status.
- `allowance_amount_positive`, `liquidation_line_amount_positive`,
  `route_standard_allowance_non_negative` — gaps Phase 5 started summing.

### API surface added

| Route                                                        | Roles                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `GET/POST /shipments/:id/allowances`, `PATCH/DELETE .../:id` | read: office + crew (scoped) · write: ADMIN/ACCOUNTING |
| `GET /shipments/:id/liquidation`                             | office + crew (scoped)                                 |
| `POST/PATCH/DELETE /shipments/:id/liquidation/lines[/:id]`   | ADMIN/OPS/ACCOUNTING/CREW (scoped)                     |
| `POST /shipments/:id/liquidation/submit`                     | ADMIN/OPS/ACCOUNTING/CREW (scoped)                     |
| `POST /shipments/:id/liquidation/{return,approve,reverse}`   | ADMIN/ACCOUNTING                                       |
| `GET /liquidations?status=&returnedOnly=`                    | office; crew scoped to own trips                       |
| `GET /shipments/:id/settlement`                              | office + crew (scoped)                                 |
| `POST /shipments/:id/settlement/{record,carry-to-payout}`    | ADMIN/ACCOUNTING                                       |
| `GET /settlements/outstanding`                               | office                                                 |
| `POST /receipts`, `GET /receipts/:id[/content]`              | upload: ADMIN/OPS/ACCOUNTING/CREW · read: per receipt  |

Four named actions rather than one `PATCH /status`, because the payloads genuinely differ —
returning and reversing require a reason, submitting and approving do not. The transition
table in `@eztruckr/types` is still the only thing that says which moves exist; each
endpoint asks it.

### Web

Three cards on the shipment detail (allowances, liquidation, settlement), a shared
`ReceiptField` that uploads on choose, the crew portal's "Liquidations waiting on you" with
the latest return reason, and two dashboard alerts — allowances outstanding, and returned
for correction. The route form gained a standard allowance.

A crew session sees the liquidation card (their half of the trip's cash) and nothing else
new: no allowance releases, no settlement, no charges, no levers.

---

## Current verified state (end of Phase 5)

- **`pnpm run check`**: 14/14 tasks passing, uncached.
- **223 tests**, all passing (was 199):

  | Workspace        | Count | Added in Phase 5                                                                            |
  | ---------------- | ----- | ------------------------------------------------------------------------------------------- |
  | `packages/types` | 73    | the appended PENDING code, the retired 3, the backwards-running order, the four legal moves |
  | `packages/db`    | 58    | four new code-column drift guards; a retired code is refused by raw SQL as well as by TS    |
  | `apps/api`       | 92    | `liquidation-lifecycle` [13] — the first DB-backed tests in this workspace                  |

- **The brief's three required assertions, each asserted twice** — in
  `apps/api/src/liquidation/liquidation-lifecycle.test.ts` against a real database, and
  again live through HTTP:
  - **return → resubmit → approve posts exactly one set of costs.** After a full cycle:
    `recognisedCost` 4,500 (not 9,000), two lines (not four), one live liquidation, one
    settlement, and a history of `[SUBMITTED, RETURNED, SUBMITTED]`.
  - **a returned liquidation contributes nothing.** `totalLiquidated` 3,500 and
    `recognisedCost` `0.00` at the same time — the figures are visible and unrecognised.
  - **an approved liquidation with an unsettled variance still reports its allowance as
    outstanding.** Liquidation APPROVED, settlement OUTSTANDING at 1,500, and the shipment
    on `GET /settlements/outstanding`.

- **Phase 4's assertions still pass unchanged** (`netRate 16200` → base 12,150, driver
  1,822.50, helper 911.25; with a 1,500 commissionable charge → 995.63 half-up).

- **50 live checks against the containerised stack**, in order: created a route with a
  standard allowance; booked a trip; confirmed **no liquidation exists before delivery**;
  dispatched → in transit → delivered, and found a liquidation at PENDING with
  `submittedAt` null; saw the route standard offered as a default for the first release
  only; released 4,500 cash then a 1,500 e-wallet top-up with a reference, and got
  **6,000 advanced from two surviving rows**; was refused a zero release; uploaded a PNG
  receipt and got the **exact bytes back through the API**; was refused a `text/plain`
  upload (415); was refused approval of work never submitted; was refused a return with no
  reason; returned it and saw PENDING + `wasReturned` + the reason; found it via
  `returnedOnly=true`; resubmitted and approved to **4,500 recognised, variance 1,500**;
  was refused a further release and a further line; computed commissions and watched the
  shipment **earn LIQUIDATED**; reversed the approval and watched the shipment drop back to
  PENDING_LIQUIDATION with the settlement gone and the approver cleared; re-approved;
  was refused a carry naming someone who never worked the trip; carried it to payout and
  found the crew deduction; confirmed it **stays on the outstanding alert**; then, as the
  crew login, listed its own liquidations, read one, saw the return reason, and was refused
  both settling and releasing cash to itself.
- **Browser-verified**: the dashboard's outstanding-allowances alert; the shipment detail
  rendering the liquidation card with its four figures, the receipt link on one line and
  "No receipt attached" on the other, and the full submit/return/submit history; the
  allowances card showing both releases with their modes and the frozen-by-approval notice;
  the settlement card showing "Carried to payout — ₱0.00 taken so far"; and the crew
  portal's "Liquidations waiting on you".
- `prisma migrate status`: 10 migrations applied, no drift. Seed still idempotent.
- **Table count**: 26 business + 3 Better Auth infra (`session`, `account`, `verification`)
  = **29 domain tables**. `information_schema.tables` returns **30** with Prisma's own
  `_prisma_migrations`.
- **The migration chain was replayed from scratch** into a throwaway database
  (`eztruckr_p5replay`, since dropped). All ten applied cleanly and the invariants held on
  a virgin schema: 0 enum types, 0 float columns, 0 naive timestamps, 29 domain tables,
  9 payout triggers, 21 partial unique indexes, 24 `_created_by_required` CHECKs,
  26 `_soft_delete_consistent` CHECKs, `liquidation_status_code_valid` accepting exactly
  `(1, 2, 4)`, `liquidation.status` defaulting to 4, `submittedAt` nullable, and
  `finalizedAt`/`finalizedBy` gone.

### Test data left in the development database

A fresh volume is unaffected. `docker compose down -v && docker compose up -d --build`
gives a clean database with the seed only.

- **Phase 4's `SH-2026-0001` and `SH-2026-0002` are gone**, along with the hand-inserted
  `itest-liq-1` liquidation the previous handoff warned about. The `liquidation` table was
  empty when Phase 5 began, which is why appending a status code reinterpreted nothing.
- Several `SH-P5-*` shipments from the live verification script, at various points in the
  lifecycle. The most recent is LIQUIDATED with a carried settlement and a ₱1,500 crew
  deduction against Ricardo Dela Cruz; an earlier one sits at PENDING with 6,000 advanced
  and nothing claimed, which is what makes the crew portal card visible.
- A handful of `P5-*` routes carrying a 4,500 standard allowance.
- One receipt object in MinIO (`receipts/<uuid>.png`), attached to a fuel line.
- A client-scoped FORMULA rule (`Northport driver formula`,
  `(net_rate + additional_charges) * 0.12`) and a replacement `Default helper commission`
  rule survive from Phase 4.
- `driver@eztruckr.ph`'s password is `eztruckr-dev-crew`. It is linked to **Joel Bautista**
  (helper-only) while the login's display name still reads "Ricardo Dela Cruz" — a Phase 4
  dev-data quirk, harmless and worth knowing before it looks like a bug.

**Integration tests share this database.** `apps/api`'s new suite prefixes its rows
`p5test-`, deliberately NOT the `itest-` prefix `packages/db` uses: turbo runs both
workspaces at once, and that suite's teardown deletes everything matching `itest-%`.
Its cleanup matches child rows by their SHIPMENT rather than by id, because the services
under test generate cuids — matching on id alone leaves allowances behind, and the next
run's deterministic shipment ids pick them straight back up.

---

## Tech stack confirmed in use (per brief, no substitutions)

Turborepo · Docker + docker compose · Next.js App Router + TypeScript · shadcn/ui + Tailwind v4 · TanStack Query · NestJS + TypeScript · Prisma · PostgreSQL 16 · currency.js (configured once in `packages/types/src/money/money.ts`, `{ symbol: '₱', precision: 2 }`) · MinIO (S3-compatible) · Prettier (root-level Turborepo task `//#format:check`) · Better Auth 1.6.26.

**No dependency has been added since Phase 3.** Phase 4's exact arithmetic is a ~140-line
BigInt rational module rather than a library. Phase 5's uploads use the `FileInterceptor`
already inside `@nestjs/platform-express` and `PutObject`/`GetObject` from the
`@aws-sdk/client-s3` that was there from Phase 1; serving the bytes through the API rather
than by presigned link keeps `@aws-sdk/s3-request-presigner` out of the tree, and is the
right shape for authorisation anyway.

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

## Decision record — all open questions resolved

Nothing here is awaiting an answer. Kept as a record so a later session can see what was
decided and why, rather than reopening it.

### Confirmed by the user at the end of Phase 4

| #   | Question                                                                  | Decision                                                  |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Trucks were added by me, not in the brief's domain-concepts list          | **Correct as built.** Keep.                               |
| 2   | `Shipment.appliedTpcRate` semantics                                       | **Correct as built.** Rate _or_ flat amount, never both.  |
| 8   | `Commission.appliedRate` nullable and unbounded for fixed/formula methods | **Correct as built.**                                     |
| 9   | Dropping `isSettled` leaves a write-off nowhere to live                   | **No write-offs.** See below — this one has consequences. |
| 10  | Charges editable after computing, until something is paid                 | **Correct as built.**                                     |

#### 9 in full: crew debts are never written off

Confirmed by the business. A crew debt is either recovered in full or carried
indefinitely; there is no state where a deduction is closed while still partly
unrecovered.

That makes the current model complete rather than merely adequate: settlement is derived
(`recoveries` sum to `amount`) and needs no flag, and a partly-recovered debt simply
stays open, which is the real behaviour.

**Do not add an `isSettled` column or a write-off amount.** The temptation will come up
in Phase 6, when payout screens want to show "closed" deductions — they should compute
it. Recorded in the `CrewDeduction` docblock in `schema.prisma` as well as here, because
that is where somebody would be about to add it.

If the business ever does start forgiving debts, a write-off is its own record with a
reason and an approver (like `Adjustment`) — not a boolean that can disagree with the sum
underneath it.

### Resolved earlier, with the reasoning that mattered

| #   | Question                                           | Resolution                                                                                                                     |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 3   | `CommissionRule` vs `SystemSetting` fallback       | Phase 3. `CommissionRule` is the only source of truth for crew pay; a shipment matching no rule raises rather than defaulting. |
| 4   | Deduction recovery across payout runs              | Phase 4. Join table `crew_deduction_recovery` — a deduction is divisible, unlike a commission.                                 |
| 5   | 1:1 relations modelled as 1:many                   | Phase 3. `liveOne()` / `liveOneOrThrow()` assert-and-unwrap the single live row.                                               |
| 6   | `user.email` only partially unique                 | Phase 3. Better Auth's adapter uses `findFirst`, so it never assumed total uniqueness.                                         |
| 7   | Gas override sharing a column with the frozen rate | Phase 4. Split into input (`gasRateOverride`) and output (`appliedGasDeductionRate`).                                          |

### Decided during Phase 5, without a question needing to be asked

The brief settled most of this phase itself. Four calls it did not cover were made here,
each one following an existing rule in the codebase rather than inventing a new one:

| Decision                                                             | Why                                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PENDING appended at code 4; FINALIZED (3) retired, never reused      | Codes are permanent. The table was empty, so a renumber was safe — and buys only a tidier constant, since order comes from the declared sequence.                           |
| Reversal moves the shipment back to PENDING_LIQUIDATION              | The status is derived from two facts; retracting one and leaving LIQUIDATED would let the close guard pass on a claim that is no longer true. Refused outright once CLOSED. |
| CARRIED_TO_PAYOUT creates an ordinary `CrewDeduction`, positive only | That machinery already recovers in slices, refuses over-recovery and freezes on PAID. Money the company owes is handed over, not deducted — a run has nothing to recover.   |
| Receipt bytes stream through the API, not a presigned URL            | A presigned link outlives its request and travels outside `RolesGuard`; a receipt is exactly what one crew member may see and their colleague may not.                      |

### The pattern worth carrying forward

Three of these — 4, 7, and the `isSettled` question that fell out of 4 — were the same
defect: **one column doing two jobs, with a convention rather than a constraint keeping
the two apart.** In every case the giveaway was that no CHECK could express the rule,
because the database held the same missing information the reader did.

`Allowance` and `Liquidation` were the next tables to be built on, and Phase 5 read them
with exactly that lens: the settlement record exists because "was the spending accounted
for" and "did the change come back" were one column's worth of information short.

---

## Phase 6 — start here

### First: the brief does not define Phase 6

The specification supplied by the user covers **Phases 1 to 4**; Phase 5's scope arrived as
its own written brief. Everything below is inferred from the domain concepts and the tables
that still have no behaviour.

**Ask the user for the Phase 6 scope before building.** The most likely shape, from the
brief's own domain concepts and the P&L formula it specifies, is **payout runs → P&L
reporting** — but that is a guess, and the user has been specific about scope every time
they have been asked.

What remains unbuilt: `PayoutRun`, `PayoutLine`, `Adjustment`, and the reporting side of
`AuditLog`. `CrewDeduction` / `CrewDeductionRecovery` have rows and constraints and
triggers but still no service. All exist as tables with full audit, soft-delete and
constraint coverage.

### The contract Phase 5 leaves

- **`SettlementService.clearRecoveredCarryovers(actorId)` is waiting for its caller.** A
  CARRIED_TO_PAYOUT settlement becomes SETTLED when its `CrewDeduction` is fully recovered
  by runs marked PAID. Call it when a run is marked Paid; do not re-derive the rule in the
  payout code.
- **`shipmentStatusAfterLiquidationMilestone()` is the only definition of LIQUIDATED.**
  Both the commission side and the liquidation side call it. If a third thing ever affects
  the status, extend that function.
- **Cost recognition is derived, not posted.** `recognisedCost` is computed from the
  liquidation status on every read. A P&L report should sum `liquidation_line.amount` where
  the liquidation is APPROVED — not a ledger table, and not a `posted` flag. That is what
  makes a return-and-resubmit cycle safe.
- **The allowance is not a P&L cost.** It is a receivable from the crew, cleared by the
  liquidation. **The gas deduction is not one either** — actual fuel is recognised through
  the liquidation, and counting it in the P&L as well would double it. Both traps are
  documented in `commission-chain.ts` and in the formula field catalog.
- **Money locks on `paid` for commissions and charges; approval is the lock for the
  liquidation.** These are not in conflict: `paid` guards figures a voucher depends on, and
  a liquidation line feeds no commission. Approval's lock guards the frozen variance, which
  is why reversing it is refused once the settlement has moved.
- **Crew debts are never written off** — see question 9 below. A payout screen showing
  "closed" deductions should compute it from the recoveries.
- **A rule that has paid anything deactivates rather than deletes.** Commissions hold
  `appliedRuleId`, so history references the rule. Expect the same of anything Phase 6
  links from a payout.
- **There is still no fallback rate.** A shipment matching no commission rule raises.

### Where the useful machinery already is

| Need                                  | Use                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Money arithmetic                      | `money()`, `multiplyByRate()`, `sum()`, `toDecimalString()` in `@eztruckr/types` |
| Exact arithmetic with no 2dp rounding | `apps/api/src/commission/rational.ts`                                            |
| Reference-aware removal               | `apps/api/src/master-data/removal.ts` — probes, then deactivate vs delete        |
| Role policy                           | `apps/api/src/auth/role-policy.ts` — declared once, never inline                 |
| Soft-delete escape hatches            | `withDeleted()`, `withHardDelete()` from `@eztruckr/db`                          |
| Single live row from a partial-unique | `liveOne()` / `liveOneOrThrow()`                                                 |
| Row → response conversion             | `apps/api/src/master-data/serialize.ts` — decimals as strings, dates as ISO      |
| Declarative master-data screens       | `apps/web/src/lib/resource-spec.ts` + `resources.tsx`                            |
| File upload / download                | `StorageService.put()/get()` + `ReceiptsService` — one pipeline, all attachments |
| Crew scoping off a shipment           | `apps/api/src/liquidation/shipment-access.service.ts`                            |
| DB-backed service tests               | `apps/api/src/liquidation/liquidation-lifecycle.test.ts` — the pattern to copy   |

### Still worth doing

- **An API e2e harness (supertest).** Still the biggest hole. Phase 5 closed part of it by
  testing `LiquidationService`, `AllowancesService` and `SettlementService` against a real
  database — which is the pattern to extend — but the guards, the per-route role policy and
  the crew scoping are still proved only by a Python script driving the running stack, not
  by anything CI re-runs.
- **`CommissionService.computeForShipment` still has no test**, only live verification.
  Phase 5 demonstrated the way to write one: build the service by hand over a real Prisma
  client, wrap the calls in `withActor`, and clean up by relationship rather than by id
  prefix. It is now a short job rather than a design question.
- **The web app has no tests at all.** Not a Phase 5 regression, but the card components now
  carry real conditional logic (who may edit, which actions are legal, what the reason box
  is for) that is currently only checked by looking at it.

### How this codebase expects to be worked on

Learned across five phases; following it will make the next session much smoother.

- **Structural enforcement over convention.** If a rule matters, express it as a
  constraint, a trigger, or a type — not a comment and not discipline. `RolesGuard` fails
  closed, the soft-delete filter lives in one extension, `MoneyInput` excludes `number`.
  The pattern that caught three bugs in Phase 4: **if no CHECK can express the rule, the
  schema is probably missing a column.**
- **Never invent a number.** Every failure in the money path refuses and says why. There
  is no default rate, no clamp to zero, no silent fallback.
- **Freeze what a figure depended on**, onto the row it produced. Anything named
  `applied*` is one of those copies and is written only by the engine.
- **Comments explain why, not what** — particularly where a choice looks odd. Most of the
  long docblocks in this repo exist because the obvious alternative is wrong for a reason
  that is not visible locally.
- **`pnpm run check` is the gate**: format, lint, typecheck, test across every workspace.
  It was green at every commit of Phases 4 and 5.
- **Verify against the running stack, not just the tests.** Every claim about behaviour in
  this document was checked live through the API before it was written down.
- **A status that behaves identically to another status is not a status.** Phase 5 declined
  `RETURNED` and `FINALIZED` on that test, and both refusals paid for themselves: the
  question `RETURNED` would have answered is answered better by an append-only history
  table that also says who, when and why.

### If a migration turns out to be wrong before it is committed

Phase 5 needed this once — two CHECK constraints were too strict and were only found while
writing the service against them. Prisma refuses to re-run an edited migration, and
`migrate reset` would have destroyed data the user may still want:

1. Hand-write the inverse DDL and run it in one transaction, ending with
   `DELETE FROM "_prisma_migrations" WHERE migration_name = '<name>'`.
2. Fix the migration file.
3. `prisma migrate dev` re-applies it as if for the first time.

The result is a single clean migration rather than a corrective second one, which matters
because the chain gets replayed from scratch as a verification step.

### Housekeeping on the development machine

The Docker VM ran out of disk during Phase 4 — Postgres could not extend a file, which
failed a migration mid-run (it rolled back cleanly and was re-applied after pruning).
Pruning dangling images reclaimed 9GB. Roughly 19GB of build cache and 14GB of unused
images remain reclaimable via `docker builder prune` / `docker image prune -a` if it gets
tight again. The host volume is separately at 97% (35GB free of 926GB).

Repeated `docker compose up --build` cycles are what filled it, so a long session will do
the same. Worth watching if a migration fails for no apparent reason.
