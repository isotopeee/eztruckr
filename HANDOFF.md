# EZTruckr — handoff

Trucking operations system. Turborepo monorepo, Philippine haulage domain (₱, Asia/Manila).

**Last commit: `565979a`**, merged to `main`. `pnpm run check` green (99 types + 215 api +
60 db), no schema drift.

**There are no default logins.** Development starts empty and is set up at `/setup`.

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

- **Postgres 18, and the version is load-bearing.** Every primary key is
  `uuid DEFAULT uuidv7()` — the function built in to 18, no extension and no fallback, so an
  older server fails at the first `CREATE TABLE`. The 18 images also moved the data directory:
  the volume mounts at **`/var/lib/postgresql`**, not `.../data`, or the container
  restart-loops.
- **UUIDv7 primary keys, `uuid` columns, not text.** Time-ordered in the leading 48 bits, so
  inserts land at the right edge of the index. Two consequences: a malformed id is a **cast
  error**, not a miss (`idSchema` refuses it at the boundary; the Prisma filter maps `P2023`
  to a 404), and raw SQL comparing an id to a JS string needs `::uuid` — `auth.ts` does, for
  `lastLoginAt`. `uuidv7()` in `@eztruckr/db` is for callers needing an id before the row.
- **`00000000000000_init` is the baseline, and is never edited.** The 19-migration chain was
  collapsed into it when primary keys changed type. It is hand-assembled — `migrate diff`
  writes the tables, and sections 2–5 (trigger functions, CHECKs, partial uniques, comments)
  are everything Prisma cannot express — so **regenerating it wholesale drops every guarantee
  the database actually enforces.** New work gets its own migration in the same shape;
  `20260814120000_staff_invitations` is the worked example, and three smaller ones follow it.
- **No Postgres enums.** Every code set is a `SMALLINT` with a CHECK and a
  `COMMENT ON COLUMN` naming the set in `@eztruckr/types`. Order comes from a declared
  sequence, never from the numeric value.
- **Code SETS are permanent** — never renumbered, never reused, append-only. Relaxed twice by
  explicit decision, both times because the table was empty. (The SMALLINT enums. The free-text
  `code` columns master data used to carry are a different thing, and are gone.)
- **Master data has no `code` column.** Nothing keyed off them — no service looked a record up
  by one, no money logic referenced one — and `naturalCodeSchema`'s justification, that codes
  "appear in exports and printed vouchers", described features that do not exist. **`name`
  carries the partial unique instead** on five tables; staff carries none. The schema survives
  for `truck.plateNumber`, the one identifier here that exists outside the system.
- **Soft delete everywhere**, via a Prisma extension (`withDeleted()`, `withHardDelete()`).
  Uniqueness is therefore **partial** (`WHERE "deletedAt" IS NULL`) — 24 such indexes, which
  Prisma cannot express, so there is no `upsert` in the seed.
- **`createdBy` is nullable to Prisma and NOT NULL in Postgres** via a CHECK (27 tables;
  `user` and `user_profile` exempt). Filled by an audit extension over AsyncLocalStorage.
- **Money is `DECIMAL(15,4)` in the database and a decimal STRING on the wire.** Never a JSON
  number. currency.js configured once, at precision 2. The web app never computes it.
- **Derived, not stored**: `recognisedCost`, `commissionsStale`, `totalAdvanced`,
  `grossProfit`, crew-pay net. A stored copy is one more thing that can be wrong.

**Counts (verified live):** 32 domain tables (29 business + 3 Better Auth), 27
`_created_by_required`, 29 `_soft_delete_consistent`, 24 partial uniques, 9 payout triggers,
11 functions, 58 code-column comments, 177 `uuid` columns, **5 migrations**.
`code-constraints.test.ts` asserts the first of those, so adding a table fails there until the
number is bumped — the point being that a forgotten CHECK surfaces now rather than years later
as a row nobody can attribute.

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
  records. `commission.role` and `commission_rule.role` carry `CHECK (role IN (1,2))` named
  `*_role_is_a_crew_role`, so **a dispatch manager cannot hold a commission** by construction
  rather than by care.

**Staff have NO natural key, and that is a decision.** `staffCode` went with the other five
codes, and `name` cannot replace it: two people here can genuinely be called Jose Santos, so a
unique on `(firstName, lastName)` would refuse a legitimate hire and the only way to satisfy it
would be typing a discriminator into a field that means something else. So: **the database
accepts two identical staff rows** (verified, not assumed); the **seed's idempotency guard is
the only thing** stopping a second run duplicating everybody; and the user screen's staff
picker appends phone or email to tell two people apart. If an employee number ever exists on
paper, add it back as its own column — cheap, because a code lives only on master data and is
never frozen onto a transaction.

**`staff.email` and `user.email` are two columns doing two jobs.** `user.email` is the
CREDENTIAL — partial-unique, Better Auth's, and changing it changes which account exists.
`staff.email` is contact detail: optional, not unique. They look redundant where the same
address appears twice, and merging them is the obvious-looking cleanup — but a staff member may
have no login, an office login has no staff row, two people can share a mailbox while two
logins cannot share an email, and correcting a typo in contact details must never move an
account. A link would be nullable both ways and unique in one: the shape that has bitten this
codebase four times.

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

**A liquidation is one custodian's account of one trip's cash.** It was one row per shipment,
which blended two people's money: a single `variance` could say what the TRIP was short by and
never which of them owed it, and the outstanding-allowances alert built on it could name a
shipment and never a person. Every action takes a **liquidation id**, not a shipment id; only
the lists and the create take a shipment.

- `Allowance.liquidationId` and `Settlement.liquidationId` are enforced by **composite
  foreign keys** on `(liquidationId, shipmentId)` → `liquidation (id, shipmentId)`. That is
  why `shipmentId` stays on both tables rather than being reached through the liquidation:
  the redundancy is what the database checks. In Prisma the target unique uses **`map:`, not
  `name:`** — `name:` only renames the client-side key and leaves drift.
- **`custodianId` is nullable**, for exactly one row: the liquidation created at BOOKING,
  before anybody is assigned. `createLiquidationSchema` requires one anyway.
- Partial unique `(shipmentId, custodianId) NULLS NOT DISTINCT WHERE deletedAt IS NULL` — one
  open account per person per trip, and only one with nobody's name on it.
- **Who received cash ≠ who answers for it.** A helper can be handed ferry money the driver
  is custodian of. Flattening them would lose a fact.
- **A custodian need not be on the truck.** A dispatch manager holds a float without driving.
  `assertMayHoldTripCash` states that rule once for all three of its callers — custodian,
  release recipient, carried debt.

**Why each record is separate**, since merging any pair is the tempting mistake: an
**allowance** is a receivable, never a cost; a **liquidation line** is what it was spent on;
the **settlement** is whether the change came back. A **billable expense** is revenue, and
its cost lands wherever the money actually went out — counting both double-counts. A
**company-paid expense** is a trip cost nobody on the trip can liquidate. An **adjustment**
is never an edit to a `Commission`, which states its own arithmetic so a voucher is
re-derivable a year later.

### Statuses

`ShipmentStatus` 1 DRAFT · 2 DISPATCHED · 3 IN_TRANSIT · 4 DELIVERED · 5 PENDING_LIQUIDATION
· 6 LIQUIDATED · 7 CLOSED. **DELIVERED is a transition, not a resting place** — recording
delivery writes PENDING_LIQUIDATION in the same statement.

`LiquidationStatus` 1 PENDING · 2 SUBMITTED · 3 APPROVED. **No RETURNED and no FINALIZED**,
on purpose: a return puts the row back at PENDING and the append-only `LiquidationHistory`
says who, when and why. _A status that behaves identically to another is not a status._

LIQUIDATED is **earned, not requested**: **every** liquidation approved AND commissions
computed. One predicate, `shipmentStatusAfterLiquidationMilestone`, called from both sides so
they cannot drift, and it runs **backwards** on reversal.

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

"Decides money" is `CAN_WRITE_SHIPMENT_MONEY`, which `CAN_DECIDE_LIQUIDATION` is defined as —
releasing cash, approving/returning/reversing a liquidation, settling, closing a trip.
**DISPATCH_MANAGER's absence from it is a control, not a job description**: they are
custodians, so releasing would let them pay themselves and approving would let them sign off
their own float. `role-policy.test.ts` asserts it, because "the dispatcher obviously needs to
approve things" is the change somebody will propose later.

**Linked logins.** `ROLES_LINKED_TO_STAFF` = CREW and DISPATCH_MANAGER carry a `user.staffId`;
every other role must have none. They are linked for opposite reasons — a crew link IS the
scope key every crew-facing query filters on, while a dispatch manager is **not scoped by it**
and carries it only so their own floats can be told apart. The one exception is
`GET /liquidations`, which scopes every linked role because it is a work queue the portal
titles "waiting on you", and handing accounting's queue to somebody who cannot act on any of
it is a list that disagrees with its own heading.

### What a CREW session may see

All enforced on the API — the web only mirrors it, because hiding a row in the browser is a
courtesy and the JSON is one devtools tab away.

| Thing            | Crew see                                  | Enforced by                                   |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| Trips            | only ones they drove or helped on         | `scopeToCaller` + `assertCrewMayRead`         |
| A trip's money   | **nothing** — no rate chain, no base      | `redactRevenueForCrew` (shipments controller) |
| Pay & commission | **nothing at all** — no amount, no net    | CREW absent from both routes' `@Roles`        |
| Liquidations     | only accounts they are **custodian** of\* | `listForShipment` filter                      |
| Reference data   | expense categories + payees, read-only    | `CAN_READ_LIQUIDATION_REFERENCE_DATA`         |

\* Custodianship, **not** who received the cash: a helper handed ferry money out of the
driver's float appears on an `Allowance` inside the driver's account, which is still the
driver's to answer for. The account created at booking names nobody, so crew never see it.

**"Paid to" is NOT role-dependent, and that is deliberate.** It shows on both disbursement
forms for everyone; only its REQUIREDNESS varies, driven by `ExpenseCategory.requiresPayee`.
It was briefly hidden from crew on optional categories, which made the field appear and
disappear as the category changed and left the office and the crew looking at different
forms — while `company-expenses-card.tsx` had never done it, so the two disbursement forms
disagreed for no reason a user could infer. The "a toll booth has no vendor" case is handled
by the field offering **"Not recorded"** when optional, not by removing the field.

Money visibility narrowed in three explicit steps (the base only, then the amount without its
arithmetic, then nothing), so the assertions matter: `crew-visibility.test.ts` pins the
redaction on **both** the detail and the list, and `role-policy.test.ts` pins CREW's absence
from `CAN_READ_SHIPMENTS` — which is what actually closes `/commissions` and `/crew-pay`.

**What that costs.** A crew member can no longer see an adjustment against their pay; they meet
it as a short payout instead, the exact failure the crew-pay route was built to prevent. A
business decision, not an oversight. To undo it, re-add `UserRole.CREW` to `crewPay` **and
filter to `user.staffId`** — the roll-up covers every crew member on the trip. Both docblocks
carry that warning, because the filters that used to do it **were deleted, not left dead**:
unreachable security code that no test exercises reads as protection while providing none.

`RateChainCard` returns null for crew **from inside the component**, so a new screen cannot
forget the check. And the two reference lists sat behind `CAN_READ_MASTER_DATA`, so the pickers
came back empty and the portal could not record an expense at all — a disabled dropdown that
was really a 403.

---

## Development

### First run, and why there are no default logins

**Development starts with an empty database.** `docker compose up` migrates and stops — no
seed, no accounts — and `/setup` names the first administrator, who is emailed an invite like
everyone else. Nobody's password is in this repository.

The seed still creates `admin@eztruckr.ph` and two staff logins with committed passwords, and
**it is the TEST fixture now**, run against `eztruckr_test`. `pnpm db:seed` against development
works if you want demo data, at the cost of three logins whose passwords are on GitHub.
`seedCredential` writes a password only when the account has none, so re-seeding never resets
one somebody changed.

`GET /system/status` answers `{ initialized }` to anyone and `POST /system/initialize` creates
the first ADMINISTRATOR — both `@Public()`, because there is nobody to authenticate as before
they run. `/login` redirects to `/setup` while the answer is false.

**`system_setting.initializedAt` is what closes that endpoint, and it is STORED, not derived.**
"An administrator exists" is the tempting reading and the unsafe one: removing the last
administrator would reopen a public endpoint that mints new ones. Written once, never cleared.

**The claim is one statement**, which is what makes it a control rather than a check:

```sql
INSERT INTO system_setting (id, "initializedAt", ...) VALUES ('singleton', NOW(), ...)
ON CONFLICT (id) DO UPDATE SET "initializedAt" = NOW(), ...
  WHERE system_setting."initializedAt" IS NULL
RETURNING id
```

Exactly one of two concurrent requests gets a row back; the loser's half-created administrator
is soft-deleted. There is a cheap pre-check before it, but **the pre-check is not the control**
— it only spares a refreshed setup page from creating and destroying an account. The
concurrency test holds both callers at a barrier past that pre-check, because without one the
requests serialise, the pre-check catches the second, and deleting the `WHERE ... IS NULL`
guard still passes. That happened; the barrier is what caught it.

**The bootstrap administrator's audit trail is honest rather than convenient.** Their `user`
row has `createdBy = NULL` — the one audit column the schema permits to be null, since they
have no creator — while their invitation and the settings row are attributed to _them_.
`createBootstrapAdministrator` shares `provision()` with the ordinary path and differs only in
that.

### Inviting a staff member

`POST /users` provisions an account with **no usable password** and emails its owner a link;
they choose the password, and that acceptance is their first sign-in. Nobody at the office
ever knows a working credential.

| Step          | What happens                                                         |
| ------------- | -------------------------------------------------------------------- |
| Create        | Account made, `emailVerified: false`, invitation minted, email sent  |
| Before accept | Sign-in refused — `hasUnacceptedInvitation`, in the Better Auth hook |
| Accept        | Sets the password and flips `emailVerified` to true                  |
| Resend        | Mints a NEW token and revokes the old, so only one link is ever live |
| Revoke        | Withdraws the link, and the account stays shut                       |

- **The token is stored as a SHA-256 hash**, never in plaintext, so neither a database dump nor
  an administrator reading the table yields anything acceptable. No salt and no KDF: 32 random
  bytes have nothing to brute-force, and a per-row salt would turn lookup into a table scan.
  (The opposite of the password rule, for a different reason — hence both written down.)
- **At most one pending invite per login**, by partial unique. That is what makes resend
  honest: it must revoke before inserting, so a forwarded link dies when a replacement is sent.
- **Sign-in is gated as well as password-less.** Provisioning hands Better Auth 32 random bytes
  and discards them, so there is nothing to type — but the gate is what makes REVOKE mean
  something. It runs **before** the password check, so a wrong password and a right one get the
  same answer on an unactivated account.
- **A login with no invitation at all is left alone** — the seeded three, and anything older.
  Locking those out on a missing row would take down the only account that can invite.
- **A failed email does not fail the request.** `MailService` returns a result rather than
  throwing, `deliveryError` records why, and the screen offers Resend.
- **`POST /users/:id/password` survives as break-glass**, for somebody locked out whose mailbox
  is gone. It is no longer how an account starts.

**Mail is Resend over `fetch`** — one POST, so no dependency. With no `RESEND_API_KEY` sending
FAILS by default; `MAIL_LOG_INSTEAD_OF_SENDING=true` writes the message and its link to the log
instead. **That flag is not derived from `NODE_ENV`, and must not be** — the compose stack runs
`NODE_ENV=production` because it builds the production images, so keying off it would disable
the fallback in the one place it exists for. An invite link in a log is a credential in a log.

**Four URLs move together when deploying anywhere but this laptop**: `APP_BASE_URL` and
`CORS_ORIGINS` (web origin), `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` (api origin). Change
one alone and the failure is confusing rather than obvious — an invite lands on a page that
cannot reach its API, or sign-in succeeds and the session evaporates. `NEXT_PUBLIC_API_URL` is
compiled into the client bundle, so it needs `docker compose build web`, not a restart.

### Two databases

| Database        | What it is                     | Migrated | Seeded              |
| --------------- | ------------------------------ | -------- | ------------------- |
| `eztruckr`      | development — yours to play in | on boot  | **never**           |
| `eztruckr_test` | the suites'                    | on test  | on test, every time |

`docker compose down -v && docker compose up -d --build` gives an **empty** development
database that sends you to `/setup`. Whatever is in it, you put there.

**Tests never touch it.** `prepareTestDatabase()` derives `<name>_test` from `DATABASE_URL`
(or takes `TEST_DATABASE_URL`), creates, migrates and seeds it, and both vitest projects put
that URL in `test.env`. **It refuses any name not ending `_test`**, because everything
downstream migrates, seeds and deletes rows in whatever it is pointed at.

**It takes a Postgres advisory lock, and that is not belt-and-braces.** Turbo runs the two test
projects in parallel and each calls this from its own globalSetup, so on a COLD database both
race to seed it — `migrate deploy` holds its own lock and survives, the seed does not, and one
process dies on the unique index. It fails only when the database does not exist yet, which is
exactly when nobody expects it. The lock is held on the `postgres` maintenance database,
because ours may not exist when it is taken.

`docker compose down -v` takes `eztruckr_test` with it. Nothing to do: the next `pnpm test`
rebuilds it from nothing.

The split paid for itself immediately: `code-constraints.test.ts` had a case reading
`SELECT id FROM "shipment" LIMIT 1`, which inserted nothing — and asserted nothing — whenever
no shipment existed. It had never failed, because the shared development database always had
somebody's hand-made trips lying around.

**Suites share the test database**, isolated by a reserved **uuid block** each —
`testUuid(block, name)` fixes the first 32 bits, so `WHERE id::text LIKE '<block>-%'` selects
exactly one suite's rows. `00000001` `packages/db` (deleted wholesale) · `00000002`
liquidation-lifecycle · `00000003` shipment-booking · `00000004` truck-assignment · `00000005`
trip-profit · `00000006` adjustments · `00000007` invitations · `00000008` system · `00000009`
crew-licence. Cleanup matches child rows **by relationship, not by id**, because the services
let Postgres generate those.

### Where the machinery already is

| Need                                  | Use                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Money arithmetic                      | `money()`, `multiplyByRate()`, `sum()`, `toDecimalString()` in `@eztruckr/types` |
| Exact arithmetic, no 2dp rounding     | `apps/api/src/commission/rational.ts`                                            |
| Reference-aware removal               | `apps/api/src/master-data/removal.ts` — probes, then deactivate vs delete        |
| Who a disbursement went to            | `payee` — external only; the picker is `components/shipments/payee-field.tsx`    |
| Whether a payee is required           | `apps/api/src/master-data/payee-requirement.ts` — one rule, both callers         |
| Role policy                           | `apps/api/src/auth/role-policy.ts` — declared once, never inline                 |
| Sending any email                     | `apps/api/src/mail/mail.service.ts` — Resend over `fetch`, returns a result      |
| Whether a login may sign in yet       | `apps/api/src/users/invitation-gate.ts` — one rule, hook and service             |
| Standing up the test database         | `packages/db/src/test-database.ts` — both vitest projects call it                |
| Soft-delete escape hatches            | `withDeleted()`, `withHardDelete()`                                              |
| Single live row from a partial-unique | `liveOne()` / `liveOneOrThrow()`                                                 |
| Row → response conversion             | `apps/api/src/master-data/serialize.ts`                                          |
| Declarative master-data screens       | `apps/web/src/lib/resource-spec.ts` + `resources.tsx` — eight of them            |
| Uploads                               | `StorageService` + `ReceiptsService` — one pipeline for every attachment         |
| Crew scoping off a shipment           | `apps/api/src/liquidation/shipment-access.service.ts`                            |
| Who may hold a trip's cash            | `apps/api/src/liquidation/trip-cash-participants.ts`                             |
| The same list, for the web's pickers  | `apps/web/src/components/shipments/trip-cash-holders.tsx`                        |
| DB-backed service tests               | `apps/api/src/liquidation/liquidation-lifecycle.test.ts` — the pattern           |

### Still worth doing

- **An API e2e harness (supertest).** Still the biggest hole, though smaller than it was:
  `crew-visibility.test.ts` pins the crew redaction without a container. What is proved only by
  hand is the GUARD — that a 403 actually comes back — which needs the Nest request pipeline,
  not a controller instance.
- **The web app has no tests**, and `PayeeField`, the rate-chain card, the commissions card and
  now `/accept-invite` all render conditionally on role or data. The API is the control in every
  case, so a regression leaks nothing — it just shows a crew member a field that will be
  refused, or hides one they were entitled to.
- **No invite email has ever been sent by Resend.** A key is now in `.env`, but
  `MAIL_LOG_INSTEAD_OF_SENDING` is still on and `mail.service.test.ts` stubs `fetch`, so the
  request shape is asserted (including `to` being an array, which Resend requires) while the
  account, sender and deliverability are unproven. **`MAIL_FROM` is still the shared sandbox
  sender**, which only delivers to the address owning the Resend account — inviting anyone else
  needs a verified domain and a `MAIL_FROM` on it.
- **No payout-run builder exists at all** — nothing creates a `PayoutRun` or `PayoutLine`, so no
  carried debt is recoverable yet, for anybody. Its population predicate must be a **union**:
  unpaid commissions ∪ unpaid adjustments ∪ **outstanding `CrewDeduction`s**, or anyone who owes
  money while earning no commission never appears on a run. `PayoutLine.commission` is already
  nullable, so no schema change is needed.
- **`CommissionService.computeForShipment` has no test**, only live verification.
- **Known flake, open.** `adjustments.test.ts > survives a recompute…` failed twice under the
  full gate and has not reproduced since (5/5 standalone, 3/3 concurrent with the db suite).
  Scoped entirely to block `00000006`, so the suspicion is cross-suite interference through
  global master data — commission rules, whose resolution has no fallback.

---

## How this codebase expects to be worked on

- **Structural enforcement over convention.** If a rule matters, express it as a constraint, a
  trigger, or a type — not a comment and not discipline. The pattern that has caught bugs in
  four phases: **if no CHECK can express the rule, the schema is probably missing a column.**
- **One column, one job.** Four separate defects have been the same shape: a column doing two
  jobs with a convention keeping them apart. `variance` answering for two people was the latest.
- **Never invent a number.** Every failure in the money path refuses and says why. No default
  rate, no clamp to zero, no silent fallback.
- **Freeze what a figure depended on**, onto the row it produced. Anything `applied*` is one of
  those copies and is written only by the engine.
- **Comments explain why, not what.** Most long docblocks exist because the obvious alternative
  is wrong for a reason not visible locally.
- **`pnpm run check` is the gate**: format, lint, typecheck, test, every workspace. Green at
  every commit since Phase 4.
- **Verify against the running stack, not just the tests.** The worst bug of one refactor was a
  serializer filtering `eligibleRoles` through the wrong code guard, which typechecked, passed
  154 tests, and silently served an empty role array. One API call found it.

### Rebuilding, and the two traps in it

Containers are **baked images, not mounts**, and the api image BAKES the migrations. The whole
loop, while there is no production data:

```bash
docker compose down -v && docker compose up -d --build
```

**`--build` is not optional.** A plain `up -d` re-applies the migration from the last image, and
you debug an edit that never ran — the symptom is a schema that disagrees with the file in
front of you.

**`--build` can also fail silently**, swallowing a failed build and leaving the OLD container
running, so it looks exactly like "my change did nothing". Twice it was a registry timeout on
the frontend image. When a change refuses to appear, build on its own — and `--force-recreate`
too, since compose will not always replace a container whose image tag is unchanged:

```bash
docker compose build web && docker compose up -d --force-recreate web
```

Check what is actually running with `docker inspect eztruckr-web --format '{{.Image}}'`.

If a migration is wrong **after** it has been applied and a reset is unacceptable: hand-write
the inverse DDL in one transaction ending with
`DELETE FROM "_prisma_migrations" WHERE migration_name = '<name>'`, fix the file, then
`prisma migrate dev` re-applies it as if for the first time. **`prisma migrate dev` can hang**
on an interactive prompt here; it applies the migration first, so kill it, run
`prisma migrate deploy`, and confirm with `prisma migrate diff … --exit-code`.

**Housekeeping.** The Docker VM has run out of disk four times — a failed migration mid-run,
HTTP 507 from MinIO, and twice postgres unable to write `postmaster.pid`. `docker builder
prune -f` reclaims the most. **Do not run `docker image prune -a`**: it reaches into the user's
other projects.

---

## Decision record

Nothing here is awaiting an answer. Kept so a later session sees what was decided rather than
reopening it.

| Question                                                | Decision                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Trucks, not in the brief's concept list                 | Keep.                                                           |
| `appliedTpcRate` semantics                              | Rate **or** flat amount, never both.                            |
| `Commission.appliedRate` nullable for fixed/formula     | Correct as built — a REPORTED rate, not an operand.             |
| Charges editable after computing, until **paid**        | Correct as built.                                               |
| Crew debts written off?                                 | **Never.** Recovered in full or carried indefinitely.           |
| `LiquidationStatus` renumbering                         | **Renumber** to 1/2/3; stored rows remapped.                    |
| Who may release cash                                    | ADMINISTRATOR + ACCOUNTING only.                                |
| Office roles submitting on the crew's behalf            | Allowed; history names whoever acted.                           |
| Which crew member a carried balance is charged to       | **Ask.** Never default to the driver, or to the custodian.      |
| `requiresReceipt`                                       | Stated, not enforced — the approver judges a lost ferry ticket. |
| Variance in the crew's favour                           | **Paid immediately**, never carried to a payout run.            |
| Orphaned receipts                                       | `POST /receipts/sweep-orphans`, object first then row.          |
| Does a dispatch manager earn a commission?              | **No**, for now — enforced by the crew-role CHECK.              |
| May they approve or release?                            | **No.** They are custodians; it would be their own float.       |
| Are they scoped like crew?                              | No — they see every trip. Only the work queue is scoped.        |
| Should `Payee` replace `ThirdParty`?                    | **No.** Separate tables — see below.                            |
| Can a payee be a member of staff?                       | **No.** External only; cash to crew is an `Allowance`.          |
| Is `payeeId` required on an expense?                    | **The category decides.** `ExpenseCategory.requiresPayee`.      |
| Is `requiresPayee` enforced, like `requiresReceipt`?    | **Yes** — and it is the only one of the two that is.            |
| What a crew member sees of a trip's money               | **Nothing.** Not the base, not their own commission.            |
| How a new staff member gets their password              | **They set it**, from an emailed invite link. Never an admin.   |
| How the FIRST administrator is created                  | `/setup`, once, then invited by email like everyone else.       |
| Is "initialised" derived from "an admin exists"?        | **No — stored.** Deriving it reopens a public admin endpoint.   |
| Does the seed run in development?                       | **No.** It is the test fixture; development starts empty.       |
| Should `staff.email` and `user.email` be one column?    | **No.** Credential vs contact detail — see People.              |
| Is `staff.email` required, or unique?                   | **Neither.** A driver may have none; two may share one.         |
| Do master-data tables need a `code`?                    | **No.** Nothing keyed off them; `name` carries the unique.      |
| Should staff keep theirs, at least?                     | **No** — decided against my recommendation. See People.         |
| Can two staff share a name now?                         | **Yes.** No unique on staff at all; the seed guard is all.      |
| Does a driver need a licence EXPIRY, not just a number? | **Yes, both.** Half a licence used to save and fail later.      |
| Is an expired licence rejected on the staff record?     | **No.** It is a fact worth recording; the driver slot refuses.  |
| Mail transport                                          | **Resend over `fetch`** — no npm dependency, no SMTP container. |
| Invite token in the database?                           | **Hash only.** A dump must not yield a working link.            |
| May an admin still set a password?                      | Yes, as **break-glass** — not as the way accounts start.        |

### Payees are not third parties

Opposite sides of the ledger:

|             | `ThirdParty`                           | `Payee`                                |
| ----------- | -------------------------------------- | -------------------------------------- |
| What it is  | broker who BRINGS freight              | supplier money is DISBURSED to         |
| Money       | netted off gross (`gross - tpc = net`) | a cost row, paid out                   |
| Disbursed?  | **never** — nothing pays a third party | that is the whole point                |
| Carries     | `defaultCommissionRate`                | address, TIN — voucher fields          |
| Points from | `shipment.thirdPartyId`, one per trip  | liquidation lines + company-paid, many |
| Locks on    | leaving DRAFT                          | its liquidation's APPROVED             |

Merging them puts a nullable rate on rows that can never use it — the "one column, two jobs"
shape that has caused four defects here. A broker genuinely paid for something else gets a
payee row too; duplicated contact details beat a `party` supertype that would drag `Client` in.
**`PayeeType` has no STAFF code**, same reason: cash to a crew member is an `Allowance` naming a
`Staff`, because an advance is answerable for and liquidated while a vendor payment is neither.
`billable_expense` has **no payee at all** — it is revenue, and its cost names the vendor on
whichever row the money actually left through.

### "Paid to" — required per category, and the flag is frozen onto the row

`ExpenseCategory.requiresPayee` decides — seeded on for fuel, ferry and gate pass; off for
toll, food, parking and miscellaneous. The office moves it on the Expense categories screen,
and the column defaults to **true**, so a new category is strict until relaxed. One resolver,
`payee-requirement.ts`, for both callers, which also makes it the category's existence check.

**Unlike `requiresReceipt`, this one is ENFORCED.** A missing receipt is a judgement call about
a lost ferry ticket; a missing payee is a cost nobody can reconcile against a supplier
statement. The two flags sit together in the same form and mean different strengths of thing.

**Why `payeeRequired` is copied onto every row.** A CHECK cannot reach across tables, so
"required iff this row's category says so" has no direct expression. The alternative — a
trigger reading `expense_category` at write time — loses on behaviour, not style: it enforces
against the category's CURRENT value, so flipping "Tolls" to required would retroactively
invalidate every toll line ever written and refuse the next person correcting a typo on one.
Freezing is what this schema already does with `appliedTpcRate` and friends.
`liquidation_line_payee_required` and `company_paid_expense_payee_required` pair the frozen
flag with the payee. One consequence: an **edit** re-stamps the row under the current rule, so
tightening a category means correcting an old row will demand a payee it never had — the honest
outcome, and `trip-profit.test.ts` pins both halves.

The mandatory step deleted 22 liquidation lines and 1 company-paid expense rather than
backfilling, and recomputed `totalLiquidated` and `variance` on the eight liquidations that
referenced them: **attributing a purchase to a supplier nobody recorded is inventing a fact**.
Moot now the volume has been recreated, but it is the precedent for the next one.

### Two standing "do not"s

- **Do not add an `isSettled` column or a write-off amount to `CrewDeduction`.** Settlement is
  derived (recoveries sum to amount). A partly-recovered debt simply stays open. If the business
  ever does forgive debts, that is its own record with a reason and an approver.
- **Do not reimburse a negative liquidation variance through an `Adjustment` (INCREASE).** It
  would make somebody wait for a payout run to be repaid money they spent out of their own
  pocket. `settlement_carry_is_a_debt` enforces this in the database.

---

## Phase history

Only the lessons are kept; `git log` has the rest.

**1** Compose stack, MinIO bootstrap. · **2** Data model; enums → smallint + CHECK. · **3**
Better Auth; `RolesGuard` fails closed, and `role`/`staffId` are `input: false` so no request
body can choose its own privileges. · **4** The money engine. `CommissionService` is the
**only** place that multiplies a base by a rate, rule resolution has **no fallback**, and
everything a computation depended on is frozen onto the row. _Guards keyed on **computed**
rather than **paid** made a late charge unfixable — `assertNothingPaid` is the correct line._
· **5** Allowance / liquidation / receipts / settlement. Costs are **recognised, never
posted**, which makes "return → resubmit → approve posts exactly one set of costs" true by
construction. Receipts stream through the API because a presigned link outlives its request.

**6** `235d11c` `8ee2d94` `a9d1702` `605aeb1` `cbb1d7e` `f3f8759` — shipment numbers in Manila
time, gross profit counting the **running** liquidation rather than only the approved one,
adjustments scoped by `shipmentId` (recompute recreates commissions, so `commissionId` would
orphan them), **many liquidations per shipment**, `crew_member` → `staff`, dispatch-manager
logins.

**7** `1cb8dd8` — **`payee`** (write policy `CAN_WRITE_PAYEES` = admin + operations +
accounting, because operations add a vendor mid-liquidation and accounting own the TIN a
voucher is built from, and no existing bundle held both), **Postgres 18 + UUIDv7 keys** on every
table, and the **crew portal**. Three strands in one commit: the collapsed migration could
not be split without hand-authoring a payee-free version that never existed. Only live
verification caught what the type change broke — the `lastLoginAt` raw update needed `::uuid`
(every sign-in 500'd), `eztruckr_commission_is_paid` needed a `uuid` parameter (the payout
guards silently stopped resolving), and `audit_log.entityId` stays **text** because it is
polymorphic, so comparing it to an id needs a cast.

**8** `565979a` — everything that follows from "nobody's password should be in the repo":

- **Invitations.** `POST /users` provisions an account with no usable password and emails a
  single-use link. New table `staff_invitation`, `MailService` on Resend over `fetch`, a public
  `/accept-invite` page, and a sign-in gate in the Better Auth `before` hook.
- **System initialisation.** `/setup` names the first administrator and invites them;
  `system_setting.initializedAt` closes the endpoint permanently.
- **No seed in development**, and a **separate test database** for the suites. The split found
  a test that had been asserting nothing for months.
- **Every master-data `code` dropped**, all six; `name` took the unique on five, staff on none.
- **`staff.email`** — contact detail, not a login.

The Development and model sections above carry the reasoning; this list is only the shape.

---

## Tech stack (per brief, one substitution)

Turborepo · Docker Compose · Next.js App Router · shadcn/ui + Tailwind v4 · TanStack Query ·
NestJS · Prisma · **PostgreSQL 18** · currency.js · MinIO · Prettier · Better Auth 1.6.26.

The brief said PostgreSQL 16; 18 is the one deviation, taken deliberately for its built-in
`uuidv7()`. **No dependency has been added since Phase 3.** Exact arithmetic is a hand-written
BigInt module; uploads use the `FileInterceptor` already in `@nestjs/platform-express` and the
`@aws-sdk/client-s3` present since Phase 1. Serving receipt bytes through the API keeps
`@aws-sdk/s3-request-presigner` out of the tree — and is the right shape for authorisation
anyway. Outbound mail is Resend's HTTP API called with `fetch`, which is why there is no
nodemailer and no SMTP container: one POST needed neither.
