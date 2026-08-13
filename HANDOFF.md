# EZTruckr — handoff

Trucking operations system. Turborepo monorepo, Philippine haulage domain (₱, Asia/Manila).

**Last commit: `d69792f`.** Working tree clean, `pnpm run check` green
(87 types + 162 api + 58 db tests), no schema drift.

```
apps/api    NestJS 11 — REST, guards, the money engine
apps/web    Next.js 15 App Router, Tailwind v4, shadcn/ui, TanStack Query
packages/db      Prisma schema, migrations, seed, client extensions
packages/types   Zod schemas, code sets, money helpers — shared by both apps
packages/config  eslint/tsconfig/prettier
```

Ports are deliberately non-standard: postgres **5433**, minio **9010/9011**, api **4000**
(prefix `/api`), web **3000**.

---

## Conventions that apply everywhere

- **No Postgres enums.** Every code set is a `SMALLINT` with a CHECK and a
  `COMMENT ON COLUMN` naming the set in `@eztruckr/types`. Order comes from a declared
  sequence, never from the numeric value.
- **Codes are permanent** — never renumbered, never reused, append-only. Relaxed twice by
  explicit decision, both times because the table was empty.
- **Soft delete everywhere**, via a Prisma extension (`withDeleted()`, `withHardDelete()`).
  Uniqueness is therefore **partial** (`WHERE "deletedAt" IS NULL`) — 22 such indexes.
  Prisma cannot express those, so there is no `upsert` in the seed.
- **`createdBy` is nullable to Prisma and NOT NULL in Postgres** via a CHECK (25 tables;
  `user` and `user_profile` exempt). Filled by an audit extension over AsyncLocalStorage.
- **Money is `DECIMAL(15,4)` in the database and a decimal STRING on the wire.** Never a
  JSON number. currency.js configured once, at precision 2. The web app never computes it.
- **Derived, not stored**: `recognisedCost`, `commissionsStale`, `totalAdvanced`,
  `grossProfit`, crew-pay net. A stored copy is one more thing that can be wrong.

**Counts (verified live):** 30 domain tables (27 business + 3 Better Auth), 25
`_created_by_required`, 27 `_soft_delete_consistent`, 22 partial uniques, 9 payout
triggers, 16 migrations.

---

## The model

### People

One table, `staff`, for everyone who works here. It was `crew_member` until a dispatch
manager needed to hold a trip's cash: the alternative was a custodian column pointing at
either a crew member or a user, which is one column doing two jobs.

Two code sets over **one numbering**, and `CrewRole` is _derived from_ `StaffRole` rather
than repeating it:

- `StaffRole` 1 DRIVER · 2 HELPER · 3 DISPATCH_MANAGER — what a person may be engaged as
  (`staff.eligibleRoles`).
- `CrewRole` 1 DRIVER · 2 HELPER — what they fill on a trip, and what `commission.role`
  records. `commission.role` and `commission_rule.role` carry
  `CHECK (role IN (1,2))` named `*_role_is_a_crew_role`, so **a dispatch manager cannot
  hold a commission** by construction rather than by care.

### The cash trail of a trip

```
Shipment ──┬── Liquidation (one per CUSTODIAN) ──┬── LiquidationLine     what they spent
           │                                     ├── LiquidationHistory  submissions + returns
           │                                     ├── Allowance           releases booked to it
           │                                     └── Settlement          what came back
           ├── BillableExpense      rebilled to the client → revenue
           ├── CompanyPaidExpense   the company paid directly → cost
           ├── AdditionalCharge     fee with no cost → revenue
           ├── Commission           frozen, self-verifying
           └── Adjustment           manual ± to crew pay, with a reason
```

**A liquidation is one custodian's account of one trip's cash.** It was one row per
shipment, which blended two people's money: with a driver holding ₱10,000 and a helper
holding ₱3,000, a single `variance` could say what the TRIP was short by and never which of
them owed it — and the outstanding-allowances alert, built on it, could name a shipment and
never a person. Every action takes a **liquidation id**, not a shipment id; only the lists
and the create take a shipment.

- `Allowance.liquidationId` and `Settlement.liquidationId` are enforced by **composite
  foreign keys** on `(liquidationId, shipmentId)` → `liquidation (id, shipmentId)`. That is
  why `shipmentId` stays on both tables rather than being reached through the liquidation:
  the redundancy is what the database checks. In Prisma the target unique uses **`map:`,
  not `name:`** — `name:` only renames the client-side key and leaves drift.
- **`custodianId` is nullable**, for exactly one row: the liquidation created at BOOKING,
  before anybody is assigned. `createLiquidationSchema` requires one anyway.
- Partial unique `(shipmentId, custodianId) NULLS NOT DISTINCT WHERE deletedAt IS NULL` —
  one open account per person per trip, and only one with nobody's name on it.
- **Who received cash ≠ who answers for it.** A helper can be handed ferry money the driver
  is custodian of. Flattening them would lose a fact.
- **A custodian need not be on the truck.** A dispatch manager holds a float without
  driving. `assertMayHoldTripCash` states that rule once for all three of its callers —
  custodian, release recipient, carried debt.

**Why each record is separate**, since merging any pair is the tempting mistake: an
**allowance** is a receivable, never a cost; a **liquidation line** is what it was spent on;
the **settlement** is whether the change came back. A **billable expense** is revenue, and
its cost lands wherever the money actually went out — counting both double-counts. A
**company-paid expense** is a trip cost nobody on the trip can liquidate. An **adjustment**
is never an edit to a `Commission`, which states its own arithmetic so a voucher is
re-derivable a year later.

### Statuses

`ShipmentStatus` 1 DRAFT · 2 DISPATCHED · 3 IN_TRANSIT · 4 DELIVERED · 5
PENDING_LIQUIDATION · 6 LIQUIDATED · 7 CLOSED. **DELIVERED is a transition, not a resting
place** — recording delivery writes PENDING_LIQUIDATION in the same statement.

`LiquidationStatus` 1 PENDING · 2 SUBMITTED · 3 APPROVED. **No RETURNED and no FINALIZED**,
on purpose: a return puts the row back at PENDING and the append-only `LiquidationHistory`
says who, when and why. _A status that behaves identically to another is not a status._

LIQUIDATED is **earned, not requested**: **every** liquidation approved AND commissions
computed. One predicate, `shipmentStatusAfterLiquidationMilestone`, called from both sides
so they cannot drift, and it runs **backwards** on reversal.

### What locks when — the distinction that keeps being got wrong

| Thing                | Locked by                              | Because                                            |
| -------------------- | -------------------------------------- | -------------------------------------------------- |
| Rate chain           | leaving DRAFT                          | the crew are on the road against an agreed figure  |
| Charges              | LIQUIDATED, or any **paid** commission | they feed the commission base                      |
| Crew assignment      | any **paid** commission                | the voucher names them                             |
| Truck assignment     | CLOSED only                            | a truck is paid nothing and feeds no figure        |
| Company-paid expense | CLOSED only                            | same reason as the truck                           |
| Liquidation contents | its own APPROVED                       | approval freezes that account's variance           |
| An adjustment        | its **own** payout line                | not the commission's — a late correction is normal |

Copying a guard without its reason is the recurring failure mode here;
`truck-assignment.test.ts` and `trip-profit.test.ts` pin two of these in **both** directions
so that "making it consistent" fails loudly.

### Who may do what

Declared once in `apps/api/src/auth/role-policy.ts`; `RolesGuard` **fails closed**.

| Role             | Reads | Dispatches | Submits liquidations | Decides money |
| ---------------- | ----- | ---------- | -------------------- | ------------- |
| ADMINISTRATOR    | ✓     | ✓          | ✓                    | ✓             |
| OPERATIONS       | ✓     | ✓          | ✓                    | ✗             |
| ACCOUNTING       | ✓     | ✗          | ✓                    | ✓             |
| MANAGEMENT       | ✓     | ✗          | ✗                    | ✗             |
| DISPATCH_MANAGER | ✓     | ✓          | ✓                    | **✗**         |
| CREW             | own   | ✗          | own                  | ✗             |

"Decides money" is `CAN_WRITE_SHIPMENT_MONEY`, which `CAN_DECIDE_LIQUIDATION` is defined
as — releasing cash, approving/returning/reversing a liquidation, settling, closing a trip.
**DISPATCH_MANAGER's absence from it is a control, not a job description**: they are
custodians, so releasing would let them pay themselves and approving would let them sign off
their own float. `role-policy.test.ts` asserts it, because "the dispatcher obviously needs
to approve things" is the change somebody will propose later.

**Linked logins.** `ROLES_LINKED_TO_STAFF` = CREW and DISPATCH_MANAGER: their `user.staffId`
names the person, and every other role must have none. The two are linked for opposite
reasons — a crew link IS the scope key every crew-facing query filters on, while a dispatch
manager is **not scoped by it** and carries it so their own floats can be told apart. The
one exception is `GET /liquidations`, which scopes every linked role because it is a work
queue the portal titles "waiting on you", and handing accounting's queue to somebody who
cannot act on any of it is a list that disagrees with its own heading.

---

## Development

### Logins

| Email                       | Password                | Role             | Seeded? |
| --------------------------- | ----------------------- | ---------------- | ------- |
| `admin@eztruckr.ph`         | `eztruckr-dev-admin`    | Administrator    | yes     |
| `driver@eztruckr.ph`        | `eztruckr-dev-crew`     | Crew             | adopted |
| `marites.reyes@eztruckr.ph` | `eztruckr-dev-dispatch` | Dispatch manager | yes     |
| `ops@eztruckr.ph`           | (set by hand)           | Operations       | no      |

`seedStaffLogin` keys on **`staffId`**, not the email — that column is what the partial
unique index constrains. It adopted the hand-made `driver@eztruckr.ph`, which was labelled
"Ricardo Dela Cruz" while linked to **Joel Bautista**, and corrected the name. On a fresh
volume it creates `joel.bautista@eztruckr.ph` instead.

### Test data

`docker compose down -v && docker compose up -d --build` gives a clean seeded database.
Otherwise expect several `SH-P5-*` shipments at various lifecycle points, `P5-*` routes
with a 4,500 standard allowance, a client-scoped FORMULA rule, and hand-made trips
(`test-00*`, `2026081300*`) left from live verification.

**Integration tests share this database.** Each suite uses its own prefix — `p5test-`,
`booktest-`, `trucktest-`, `profittest-`, `adjtest-` — deliberately **not** `itest-`, which
`packages/db` deletes wholesale while turbo runs both workspaces at once. Cleanup matches
child rows **by relationship, not id prefix**, because the services generate cuids.

### Where the machinery already is

| Need                                  | Use                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Money arithmetic                      | `money()`, `multiplyByRate()`, `sum()`, `toDecimalString()` in `@eztruckr/types` |
| Exact arithmetic, no 2dp rounding     | `apps/api/src/commission/rational.ts`                                            |
| Reference-aware removal               | `apps/api/src/master-data/removal.ts` — probes, then deactivate vs delete        |
| Role policy                           | `apps/api/src/auth/role-policy.ts` — declared once, never inline                 |
| Soft-delete escape hatches            | `withDeleted()`, `withHardDelete()`                                              |
| Single live row from a partial-unique | `liveOne()` / `liveOneOrThrow()`                                                 |
| Row → response conversion             | `apps/api/src/master-data/serialize.ts`                                          |
| Declarative master-data screens       | `apps/web/src/lib/resource-spec.ts` + `resources.tsx`                            |
| Uploads                               | `StorageService` + `ReceiptsService` — one pipeline for every attachment         |
| Crew scoping off a shipment           | `apps/api/src/liquidation/shipment-access.service.ts`                            |
| Who may hold a trip's cash            | `apps/api/src/liquidation/trip-cash-participants.ts`                             |
| The same list, for the web's pickers  | `apps/web/src/components/shipments/trip-cash-holders.tsx`                        |
| DB-backed service tests               | `apps/api/src/liquidation/liquidation-lifecycle.test.ts` — the pattern           |

### Still worth doing

- **An API e2e harness (supertest).** The biggest hole. Guards, per-route role policy and
  scoping are proved only by Python scripts driving the running stack, not by CI.
- **No payout-run builder exists at all** — nothing creates a `PayoutRun` or `PayoutLine`,
  so no carried debt is recoverable yet, for anybody. Its population predicate must be a
  **union**: unpaid commissions ∪ unpaid adjustments ∪ **outstanding `CrewDeduction`s**, or
  anyone who owes money while earning no commission never appears on a run.
  `PayoutLine.commission` is already nullable, so no schema change is needed.
- **`CommissionService.computeForShipment` has no test**, only live verification.
- **The web app has no tests at all**, and its cards now carry real conditional logic.
- **Known flake, open.** `adjustments.test.ts > survives a recompute…` failed twice under
  the full gate and has not reproduced since (5/5 standalone, 3/3 concurrent with the db
  suite). Scoped entirely to `adjtest-` fixtures, so the suspicion is cross-suite
  interference through global master data — commission rules, whose resolution has no
  fallback. (A separate flake **was** fixed: `turbo.json` had `test`/`typecheck`/`lint` on
  `dependsOn: ["^build"]` — upstream packages only — so `@eztruckr/db#test` raced
  `prisma generate` rewriting the client it imports, but only when the db build cache
  missed, i.e. right after a schema change.)

---

## How this codebase expects to be worked on

- **Structural enforcement over convention.** If a rule matters, express it as a constraint,
  a trigger, or a type — not a comment and not discipline. The pattern that has caught bugs
  in four phases: **if no CHECK can express the rule, the schema is probably missing a
  column.**
- **One column, one job.** Four separate defects have been the same shape: a column doing
  two jobs with a convention keeping them apart. `variance` answering for two people was the
  latest.
- **Never invent a number.** Every failure in the money path refuses and says why. No
  default rate, no clamp to zero, no silent fallback.
- **Freeze what a figure depended on**, onto the row it produced. Anything `applied*` is one
  of those copies and is written only by the engine.
- **Comments explain why, not what.** Most long docblocks exist because the obvious
  alternative is wrong for a reason not visible locally.
- **`pnpm run check` is the gate**: format, lint, typecheck, test, every workspace. Green at
  every commit since Phase 4.
- **Verify against the running stack, not just the tests.** Containers are **baked images,
  not mounts** — `docker compose up -d --build api web`, or you verify the previous build.
  This is not ceremony: the last refactor's worst bug was a serializer filtering
  `eligibleRoles` through the wrong code guard, which typechecked, passed 154 tests, and
  silently served an empty role array. One API call found it.

### If a migration is wrong before it is committed

Prisma refuses to re-run an edited migration, and `migrate reset` would destroy data:

1. Hand-write the inverse DDL in one transaction, ending with
   `DELETE FROM "_prisma_migrations" WHERE migration_name = '<name>'`.
2. Fix the migration file.
3. `prisma migrate dev` re-applies it as if for the first time.

One clean migration beats a corrective second one. **`prisma migrate dev` can hang** on an
interactive prompt here; it applies the migration first, so kill it, run
`prisma migrate deploy`, and confirm with `prisma migrate diff … --exit-code`.

### Housekeeping

The Docker VM has run out of disk twice — once failing a migration mid-run, once returning
HTTP 507 from MinIO. `docker builder prune -f` reclaims the most. **Do not run
`docker image prune -a`**: it reaches into the user's other projects.

---

## Decision record

Nothing here is awaiting an answer. Kept so a later session sees what was decided rather
than reopening it.

| Question                                            | Decision                                                        |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Trucks, not in the brief's concept list             | Keep.                                                           |
| `appliedTpcRate` semantics                          | Rate **or** flat amount, never both.                            |
| `Commission.appliedRate` nullable for fixed/formula | Correct as built — a REPORTED rate, not an operand.             |
| Charges editable after computing, until **paid**    | Correct as built.                                               |
| Crew debts written off?                             | **Never.** Recovered in full or carried indefinitely.           |
| `LiquidationStatus` renumbering                     | **Renumber** to 1/2/3; stored rows remapped.                    |
| Who may release cash                                | ADMINISTRATOR + ACCOUNTING only.                                |
| Office roles submitting on the crew's behalf        | Allowed; history names whoever acted.                           |
| Which crew member a carried balance is charged to   | **Ask.** Never default to the driver, or to the custodian.      |
| `requiresReceipt`                                   | Stated, not enforced — the approver judges a lost ferry ticket. |
| Variance in the crew's favour                       | **Paid immediately**, never carried to a payout run.            |
| Orphaned receipts                                   | `POST /receipts/sweep-orphans`, object first then row.          |
| Does a dispatch manager earn a commission?          | **No**, for now — enforced by the crew-role CHECK.              |
| May they approve or release?                        | **No.** They are custodians; it would be their own float.       |
| Are they scoped like crew?                          | No — they see every trip. Only the work queue is scoped.        |

### Two standing "do not"s

- **Do not add an `isSettled` column or a write-off amount to `CrewDeduction`.** Settlement
  is derived (recoveries sum to amount). A partly-recovered debt simply stays open. If the
  business ever does forgive debts, that is its own record with a reason and an approver.
- **Do not reimburse a negative liquidation variance through an `Adjustment` (INCREASE).**
  It would make somebody wait for a payout run to be repaid money they spent out of their
  own pocket. `settlement_carry_is_a_debt` enforces this in the database.

---

## Phase history

**1** Compose stack, health checks, MinIO bootstrap. · **2** Data model, rebuilt once; enums
→ smallint + CHECK, migration chain reset while pre-production. · **3** Better Auth 1.6.26;
`RolesGuard` fails closed; `role`/`staffId` are `input: false` so no request body can choose
its own privileges; master data + declarative screens. · **4** The money engine.
`CommissionService` is the **only** place that multiplies a base by a rate; rule resolution
has **no fallback**; everything a computation depended on is frozen onto the row.
_The bug worth remembering: guards keyed on **computed** rather than **paid** made a late
charge unfixable — `assertNothingPaid` is the correct line._ · **5** Allowance /
liquidation / receipts / settlement. Costs are **recognised, never posted**, which is what
makes "return → resubmit → approve posts exactly one set of costs" true by construction.
Receipts stream through the API because a presigned link outlives its request. · **After 5**
Truck assignment — the web app could not dispatch a single shipment, because every trip in
Phases 4–5 got its truck through the API.

**Phase 6**, committed: `235d11c` generated shipment numbers in Manila time, liquidation
created at booking, `CompanyPaidExpense`, gross profit · `8ee2d94` the **running**
liquidation counts in gross profit, not only the approved one · `a9d1702` crew adjustments,
scoped by `shipmentId` not `commissionId` because recompute recreates commissions ·
`605aeb1` **many liquidations per shipment**, one account per custodian · `cbb1d7e`
**`crew_member` → `staff`**, dispatch managers as custodians · `f3f8759` **dispatch managers
can sign in**.

---

## Tech stack (per brief, no substitutions)

Turborepo · Docker Compose · Next.js App Router · shadcn/ui + Tailwind v4 · TanStack Query ·
NestJS · Prisma · PostgreSQL 16 · currency.js · MinIO · Prettier · Better Auth 1.6.26.

**No dependency has been added since Phase 3.** Exact arithmetic is a hand-written BigInt
module; uploads use the `FileInterceptor` already in `@nestjs/platform-express` and the
`@aws-sdk/client-s3` present since Phase 1. Serving receipt bytes through the API keeps
`@aws-sdk/s3-request-presigner` out of the tree — and is the right shape for authorisation
anyway.
