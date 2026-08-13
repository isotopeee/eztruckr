# EZTruckr — handoff

Trucking operations system. Turborepo monorepo, Philippine haulage domain (₱, Asia/Manila).

**Last commit: `605aeb1`.** Working tree clean, `pnpm run check` green.

---

## The per-custodian refactor — landed

The change that was mid-flight across the previous two sessions is **complete**: many
liquidations per shipment, each with a custodian, with allowances and settlements tied to
one.

`Liquidation` was one row per shipment, which silently blended two people's money. With a
driver holding ₱10,000 and a helper holding ₱3,000, a single `variance` could say what the
TRIP was short by and never which of them owed it — and `Settlement`, built directly on
that figure, inherited the blindness, so the outstanding-allowances alert could name a
shipment but was structurally unable to name a person.

Now: **a liquidation is one custodian's account of one trip's cash.** The dashboard alert
names the person.

### Where the routes went, since the shapes changed

| Old                                                               | New                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /shipments/:id/liquidation`                                  | `GET /shipments/:id/liquidations` (a list)                          |
| `POST /shipments/:id/liquidation/lines`                           | `POST /liquidations/:id/lines`                                      |
| `DELETE /shipments/:id/liquidation/lines/:lineId`                 | `DELETE /liquidations/:id/lines/:lineId`                            |
| `POST /shipments/:id/liquidation/{submit,return,approve,reverse}` | `POST /liquidations/:id/{…}`                                        |
| `GET /shipments/:id/settlement`                                   | `GET /liquidations/:id/settlement` (+ `/shipments/:id/settlements`) |
| `POST /shipments/:id/settlement/record`                           | `POST /liquidations/:id/settlement/record`                          |
| `POST /shipments/:id/settlement/carry-to-payout`                  | `POST /liquidations/:id/settlement/carry-to-payout`                 |

Unchanged: `GET /liquidations` (queue), `GET|POST /shipments/:id/allowances`,
`GET /settlements/outstanding`, receipts.

New: `POST /shipments/:id/liquidations` (open an account, requires `custodianId`),
`PATCH /liquidations/:id/custodian`, `DELETE /liquidations/:id` (only while empty).

### Two things the earlier sessions' notes did not anticipate

- **The crew queue's scope disagreed with the write guard.** `LiquidationService.list`
  still scoped a crew session by _trip worked_ while `assertCrewMayAccount` had narrowed to
  _custodianship_. A helper would have been shown the driver's ₱10,000 under "waiting on
  you", offered a row to open, and had the write refused. It now filters on
  `custodianId`, admitting the custodian-less account for anyone who worked the trip —
  the same two branches the guard uses. Pinned by a test.
- **The outstanding alert keyed its list on `shipmentId`**, which a trip carrying two
  custodians turns into duplicate React keys. Keyed on `liquidationId` now.

### The decisions already made, so they are not relitigated

- **`custodianId` is nullable.** A trip's first liquidation is created at BOOKING, before
  anybody is assigned to drive it. `createLiquidationSchema` requires a custodian anyway —
  the nullable case exists for exactly that one auto-created row.
- **Partial unique `(shipmentId, custodianId) NULLS NOT DISTINCT WHERE deletedAt IS NULL`.**
  One open account per person per trip, and only one that has nobody's name on it.
- **`Allowance.liquidationId` + `Settlement.liquidationId` are enforced by COMPOSITE
  foreign keys** on `(liquidationId, shipmentId)` → `liquidation (id, shipmentId)`. That is
  why `shipmentId` stays on both tables rather than being reached through the liquidation:
  the redundancy is what the database checks. Prisma expresses this natively; the
  `@@unique([id, shipmentId], map: "liquidation_id_shipment_key")` uses **`map:`, not
  `name:`** — `name:` only renames the client-side compound key and leaves drift.
- **An allowance's `crewMemberId` (who received) stays independent of the account's
  custodian (who is answerable).** A helper can be handed ferry money the driver answers
  for; flattening them would lose a fact.
- **`shipmentStatusAfterLiquidationMilestone` takes `allLiquidationsApproved`**, renamed
  from `liquidationApproved`. "Somebody squared up" is a much weaker claim than "the trip
  is accounted for".
- **Crew scoping narrowed to custodianship** (`assertCrewMayAccount`). A helper who worked
  the trip has no business editing the driver's claims. An account with no custodian yet is
  open to anyone who worked the trip, or it would be unusable until an office user named
  somebody.
- **`canIssue` on the allowance summary is the permissive, trip-level half** — true while
  any account is open. Whether a particular account accepts a release is decided when one
  is named, so approving the driver's must not stop cash going to the helper.

### What the web app does with it

`liquidation-card.tsx` renders **one section per account** — its own figures, its own four
moves, its own history — so approving the driver's visibly does not touch the helper's.
`settlement-card.tsx` is a list for the same reason. The release form on
`allowances-card.tsx` asks **two** questions that look like one: who received the cash, and
which account it is booked against. `trip-crew.ts` is the shared driver/helper list all
three pickers use, because all three are refused the same way by the API.

Verified live, not only by tests: a trip with the driver holding ₱10,500 (including ₱500 of
ferry money handed to the helper) and the helper holding ₱3,100 shows two variances,
refuses a release against the approved account while accepting one against the open account,
and puts "Ricardo Dela Cruz" on the dashboard alert. That trip is `20260813002` in the
development database — delete it, or `docker compose down -v`, when it stops being useful.

### Resume checklist

```bash
pnpm run check                                                   # the gate
docker compose up -d --build api web                             # baked images, not mounts
```

---

## Repository layout

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

## The model, as it stands

### Conventions that apply everywhere

- **No Postgres enums.** Every code set is a `SMALLINT` with a CHECK and a
  `COMMENT ON COLUMN` naming the set in `@eztruckr/types`. Order comes from a declared
  sequence, never from the numeric value.
- **Codes are permanent** — never renumbered, never reused, append-only. Relaxed twice by
  explicit decision, both times because the table was empty (Phase 4 status codes; Phase 5
  `LiquidationStatus`).
- **Soft delete everywhere**, via a Prisma extension. Escape hatches: `withDeleted()`,
  `withHardDelete()`. Uniqueness is therefore **partial** (`WHERE "deletedAt" IS NULL`) —
  22 such indexes. Prisma cannot express those, so there is no `upsert` in the seed.
- **`createdBy` is nullable to Prisma and NOT NULL in Postgres** via a CHECK (25 tables;
  `user` and `user_profile` are exempt). Filled by an audit extension over AsyncLocalStorage
  (`withActor`).
- **Money is `DECIMAL(15,4)` in the database and a decimal STRING on the wire.** Never a
  JSON number. currency.js is configured once, at precision 2.
- **Derived, not stored**: `recognisedCost`, `commissionsStale`, `totalAdvanced`,
  `grossProfit`, crew-pay net. A stored copy is one more thing that can be wrong.

### Counts (verified in the live database)

27 business tables + 3 Better Auth infra = **30 domain tables** (31 with
`_prisma_migrations`). 25 `_created_by_required` CHECKs, 27 `_soft_delete_consistent`,
22 partial unique indexes, 9 payout triggers, **14 migrations**, no drift.

### The cash trail of a trip

```
Shipment ──┬── Liquidation (one per CUSTODIAN)  ──┬── LiquidationLine   what they spent
           │                                      ├── LiquidationHistory  submissions + returns
           │                                      ├── Allowance          releases booked to it
           │                                      └── Settlement         what came back
           ├── BillableExpense      rebilled to the client → revenue
           ├── CompanyPaidExpense   the company paid directly → cost
           ├── AdditionalCharge     fee with no cost → revenue
           ├── Commission           frozen, self-verifying
           └── Adjustment           manual ± to crew pay, with a reason
```

**Why each is separate**, since merging any pair is the tempting mistake:

- An **allowance** is a receivable from the crew, never a cost. A **liquidation line** is
  what they spent it on. The **settlement** is whether the change came back — a different
  question from whether the spending was accounted for, and the reason both records exist.
- A **billable expense** is revenue (rebilled); its COST lands wherever the money actually
  went out — a company-paid expense, or a liquidation line. Counting it on both sides
  double-counts.
- A **company-paid expense** is a trip cost no crew member can liquidate, because none of
  them held the money. Recognised when recorded; there is no approval to wait for.
- An **adjustment** is never an edit to a `Commission`. That row states its own arithmetic
  (`base × rate = amount` from values on the row), which is what makes a voucher
  re-derivable a year later.

### Statuses

`ShipmentStatus` 1 DRAFT · 2 DISPATCHED · 3 IN_TRANSIT · 4 DELIVERED · 5 PENDING_LIQUIDATION
· 6 LIQUIDATED · 7 CLOSED. **DELIVERED is a transition, not a resting place** — recording
delivery writes PENDING_LIQUIDATION in the same statement.

`LiquidationStatus` 1 PENDING · 2 SUBMITTED · 3 APPROVED. **There is no RETURNED and no
FINALIZED**, on purpose: a return puts the row back at PENDING and the append-only
`LiquidationHistory` says who, when and why. _A status that behaves identically to another
status is not a status._

LIQUIDATED is **earned, not requested**: every liquidation approved **and** commissions
computed. One predicate,
`shipmentStatusAfterLiquidationMilestone`, called from both sides so they cannot drift, and
it runs **backwards** on reversal.

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
`truck-assignment.test.ts` and `trip-profit.test.ts` pin two of these in **both**
directions so that "making it consistent" fails loudly.

---

## Phase history — what was built and what it cost

**Phase 1** Foundation: compose stack, health checks, MinIO bootstrap.

**Phase 2** Data model, rebuilt once. Enums → smallint + CHECK; the migration chain was
reset (pre-production, no data) rather than patched.

**Phase 3** Better Auth 1.6.26; `RolesGuard` **fails closed**; role/`crewMemberId` are
`input: false` so no request body can choose its own privileges; master data + declarative
resource screens; reference-aware removal (probe, then deactivate vs delete).

**Phase 4** The money engine. `CommissionService` is the **only** place that multiplies a
base by a rate. Five methods including a FORMULA evaluator over a field catalog served by
the API. Rule resolution has **no fallback** — no match raises. Everything a computation
depended on is frozen onto the row (`applied*`). `rational.ts` (~140 lines, BigInt) does
exact arithmetic where 2dp intermediates would drift.

- The bug worth remembering: guards were keyed on _computed_ rather than _paid_, which
  made a late charge unfixable. `assertNothingPaid` is the correct line.

**Phase 5** Allowance / liquidation / receipts / settlement. Costs are **recognised, never
posted** — `recognisedCost` is derived from the status, which is what makes
"return → resubmit → approve posts exactly one set of costs" true by construction.
Receipts stream through the API rather than by presigned URL, because a presigned link
outlives its request and travels outside `RolesGuard`.

**After Phase 5** — truck assignment. **The web app could not dispatch a single shipment**:
the create dialog hard-coded `truckId: null` and no screen offered a picker, while
`assertReadyToDispatch` requires one. Missed because every trip in Phases 4–5 got its truck
through the API. Route was missing for the same reason, which made `standardAllowance`
unreachable from the UI.

**Phase 6 so far** (all committed):

- `235d11c` — generated shipment numbers `{YYYYMMDD}{SEQ}` in **Manila time** (UTC would
  stamp the whole working morning with yesterday's date); the liquidation is created at
  **booking**; `CompanyPaidExpense`; gross profit with a breakdown; category sort order
  defaults to 10; a seeded crew login.
- `8ee2d94` — the **running** liquidation counts in gross profit, not only the approved
  one. `Liquidation.recognisedCost` (what has POSTED) and `GrossProfit.liquidatedExpenses`
  (what has been SPENT) are two questions with two answers; a test pins them apart.
- `a9d1702` — crew commission adjustments (increase/decrease + reason), scoped by
  `shipmentId` **not** `commissionId` because recompute soft-deletes and recreates
  commissions.
- `605aeb1` — **many liquidations per shipment**, one account per custodian, above. Spanned three
  sessions: schema and migration, then the API, then the web app and the tests. The
  recurring lesson held again — `variance` was one column answering for two people, and no
  CHECK could express the rule until the schema gained the column that names whose money it
  is.

---

## Development

### Logins

| Email                | Password             | Role          | Seeded? |
| -------------------- | -------------------- | ------------- | ------- |
| `admin@eztruckr.ph`  | `eztruckr-dev-admin` | Administrator | yes     |
| `driver@eztruckr.ph` | `eztruckr-dev-crew`  | Crew          | adopted |
| `ops@eztruckr.ph`    | (set by hand)        | Operations    | no      |

The crew seed keys on **`crewMemberId`**, not the email — that column is what the partial
unique index constrains and what every crew-facing query filters on. It adopted the
hand-made `driver@eztruckr.ph`, which was labelled "Ricardo Dela Cruz" while linked to
**Joel Bautista**, and corrected the name. On a fresh volume it creates
`joel.bautista@eztruckr.ph` instead.

### Test data in the development database

`docker compose down -v && docker compose up -d --build` gives a clean seeded database.
Otherwise expect: several `SH-P5-*` shipments at various lifecycle points, `P5-*` routes
with a 4,500 standard allowance, one MinIO receipt object, a client-scoped FORMULA rule
(`Northport driver formula`), and the user's own `test-001`/`test-002`.

**Integration tests share this database.** Each suite uses its own prefix — `p5test-`,
`booktest-`, `trucktest-`, `profittest-`, `adjtest-` — deliberately **not** `itest-`, which
`packages/db` deletes wholesale while turbo runs both workspaces at once. Cleanup matches
child rows **by relationship, not id prefix**, because the services generate cuids.

### Where the machinery already is

| Need                                  | Use                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Money arithmetic                      | `money()`, `multiplyByRate()`, `sum()`, `toDecimalString()` in `@eztruckr/types` |
| Exact arithmetic, no 2dp rounding     | `apps/api/src/commission/rational.ts`                                            |
| Reference-aware removal               | `apps/api/src/master-data/removal.ts`                                            |
| Role policy                           | `apps/api/src/auth/role-policy.ts` — declared once, never inline                 |
| Soft-delete escape hatches            | `withDeleted()`, `withHardDelete()`                                              |
| Single live row from a partial-unique | `liveOne()` / `liveOneOrThrow()`                                                 |
| Row → response conversion             | `apps/api/src/master-data/serialize.ts`                                          |
| Declarative master-data screens       | `apps/web/src/lib/resource-spec.ts` + `resources.tsx`                            |
| Uploads                               | `StorageService` + `ReceiptsService` — one pipeline for every attachment         |
| Crew scoping off a shipment           | `apps/api/src/liquidation/shipment-access.service.ts`                            |
| DB-backed service tests               | `apps/api/src/liquidation/liquidation-lifecycle.test.ts` — the pattern           |

### Known flake — `pnpm run check` can go red without anything being wrong

Two separate causes were found and one is fixed:

- **Fixed.** `turbo.json` declared `test`/`typecheck`/`lint` as `dependsOn: ["^build"]` —
  UPSTREAM packages' builds, not the package's own. So `@eztruckr/db#test` did not wait for
  `@eztruckr/db#build`, which runs `prisma generate` and rewrites the very client the tests
  import, failing with `Cannot find module './runtime/library.js'`. It only bit when the db
  build cache missed, i.e. immediately after a schema change — exactly when somebody is
  most likely to blame their own edit. Package-scoped overrides now add `"build"`.
- **Open.** `adjustments.test.ts > survives a recompute that replaces every commission row`
  failed twice under the full gate and has not reproduced since: 5/5 standalone runs and
  3/3 concurrent with `packages/db`'s suite all pass. It is scoped entirely to
  `adjtest-` fixtures, so the suspicion is cross-suite interference through shared master
  data (commission rules are global, and rule resolution has no fallback). If it resurfaces,
  that is the thread to pull.

### Still worth doing

- **An API e2e harness (supertest).** The biggest hole. Guards, per-route role policy and
  crew scoping are proved only by Python scripts driving the running stack, not by anything
  CI re-runs. The per-custodian work made this bigger, not smaller: `assertCrewMayAccount`
  is now the difference between two crew members on the same trip, and no CI job exercises
  it through a real session.
- **`CommissionService.computeForShipment` has no test**, only live verification. The
  pattern to copy now exists, so it is a short job rather than a design question.
- **The web app has no tests at all**, and its cards now carry real conditional logic —
  which account may take a release, which crew member may edit which section, whether the
  remove button should appear at all.
- **Renaming a custodian is API-only.** `PATCH /liquidations/:id/custodian` accepts it and
  the web only offers the picker while the account has nobody, which is the case that
  actually arises. If reassigning mid-trip turns out to be real, the releases already booked
  stay where they are and that needs saying on screen.

---

## How this codebase expects to be worked on

Learned across six phases. Following it makes the next session much smoother.

- **Structural enforcement over convention.** If a rule matters, express it as a constraint,
  a trigger, or a type — not a comment and not discipline. The pattern that has now caught
  bugs in three phases: **if no CHECK can express the rule, the schema is probably missing a
  column.** The composite FK in the current refactor is the latest instance.
- **Never invent a number.** Every failure in the money path refuses and says why. No
  default rate, no clamp to zero, no silent fallback.
- **Freeze what a figure depended on**, onto the row it produced. Anything `applied*` is one
  of those copies and is written only by the engine.
- **One column, one job.** Three separate defects across Phases 4–5 were the same shape: a
  column doing two jobs with a convention keeping them apart. The current refactor is a
  fourth — `variance` was answering for two people.
- **Comments explain why, not what**, particularly where a choice looks odd. Most long
  docblocks here exist because the obvious alternative is wrong for a reason not visible
  locally.
- **`pnpm run check` is the gate**: format, lint, typecheck, test, every workspace. It was
  green at every commit of Phases 4–6.
- **Verify against the running stack, not just the tests.** Every behavioural claim in this
  document was checked live through the API before being written down. The api/web
  containers are **baked images, not mounts** — `docker compose up -d --build api web`
  after any change, or you will verify the previous build.

### If a migration turns out to be wrong before it is committed

Prisma refuses to re-run an edited migration, and `migrate reset` would destroy data:

1. Hand-write the inverse DDL in one transaction, ending with
   `DELETE FROM "_prisma_migrations" WHERE migration_name = '<name>'`.
2. Fix the migration file.
3. `prisma migrate dev` re-applies it as if for the first time.

One clean migration beats a corrective second one, because the chain gets replayed from
scratch as a verification step.

**`prisma migrate dev` can hang** waiting on an interactive prompt in this environment. It
applies the migration first, so if it hangs: kill it, then `prisma migrate deploy`
(non-interactive) and confirm with
`prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code`.

### Housekeeping

The Docker VM has run out of disk twice — once failing a migration mid-run, once returning
HTTP 507 from MinIO on upload. `docker builder prune -f` reclaims the most.
**Do not run `docker image prune -a`**: it reaches into the user's other projects.

---

## Decision record

Nothing here is awaiting an answer. Kept so a later session can see what was decided rather
than reopening it.

### Confirmed by the user

| Question                                                | Decision                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Trucks, not in the brief's concept list                 | Keep.                                                           |
| `appliedTpcRate` semantics                              | Rate **or** flat amount, never both.                            |
| `Commission.appliedRate` nullable for fixed/formula     | Correct as built — a REPORTED rate, not an operand.             |
| Charges editable after computing, until **paid**        | Correct as built.                                               |
| Crew debts written off?                                 | **Never.** Recovered in full or carried indefinitely.           |
| `LiquidationStatus` — append PENDING at 4, or renumber? | **Renumber** to 1/2/3; stored rows remapped.                    |
| Who may release cash                                    | ADMINISTRATOR + ACCOUNTING only.                                |
| Office roles submitting on the crew's behalf            | Allowed; history names whoever acted.                           |
| Which crew member a carried balance is charged to       | **Ask.** Never default to the driver.                           |
| `requiresReceipt`                                       | Stated, not enforced — the approver judges a lost ferry ticket. |
| Variance in the crew's favour                           | **Paid immediately**, never carried to a payout run.            |
| Orphaned receipts                                       | `POST /receipts/sweep-orphans`, object first then row.          |

### Two standing "do not"s

- **Do not add an `isSettled` column or a write-off amount to `CrewDeduction`.** Settlement
  is derived (recoveries sum to amount). A partly-recovered debt simply stays open, which is
  the real behaviour. If the business ever does forgive debts, that is its own record with a
  reason and an approver.
- **Do not reimburse a negative liquidation variance through an `Adjustment` (INCREASE).**
  It would make a crew member wait for a payout run to be repaid money they spent out of
  their own pocket. `settlement_carry_is_a_debt` enforces this in the database.

---

## Tech stack (per brief, no substitutions)

Turborepo · Docker Compose · Next.js App Router · shadcn/ui + Tailwind v4 · TanStack Query ·
NestJS · Prisma · PostgreSQL 16 · currency.js · MinIO · Prettier · Better Auth 1.6.26.

**No dependency has been added since Phase 3.** Exact arithmetic is a hand-written BigInt
module; uploads use the `FileInterceptor` already in `@nestjs/platform-express` and the
`@aws-sdk/client-s3` present since Phase 1. Serving receipt bytes through the API keeps
`@aws-sdk/s3-request-presigner` out of the tree — and is the right shape for authorisation
anyway.
