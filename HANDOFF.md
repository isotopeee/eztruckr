# EZTruckr — handoff

Trucking operations system. Turborepo monorepo, Philippine haulage domain (₱, Asia/Manila).

**LIVE** at `https://eztruckr.optimuslogisticscorp.com`, phase 9 shipped. `pnpm run check` green
(140 types + 314 api + 63 db), no schema drift. **No default logins** — every install starts empty
and is set up at `/setup`.

```
apps/api    NestJS 11 — REST, guards, the money engine
apps/web    Next.js 16 App Router, Tailwind v4, shadcn/ui, TanStack Query
packages/db      Prisma schema, migrations, seed, client extensions
packages/types   Zod schemas, code sets, money helpers — shared by both apps
packages/config  eslint/tsconfig/prettier
```

Ports are deliberately non-standard: postgres **5433**, minio **9010/9011**, api **4000**
(prefix `/api`), web **3000**.

---

## Conventions

- **Postgres 18, load-bearing.** Every PK is `uuid DEFAULT uuidv7()`, built into 18 with no
  fallback, so an older server fails at the first `CREATE TABLE`. The 18 images moved the data
  directory: the volume mounts at **`/var/lib/postgresql`**, not `.../data`, or it restart-loops.
- **UUIDv7 keys, `uuid` columns, not text.** A malformed id is a **cast error**, not a miss
  (`idSchema` refuses it at the boundary; the Prisma filter maps `P2023` to a 404), and raw SQL
  comparing an id to a JS string needs `::uuid` — `auth.ts` does, for `lastLoginAt`.
- **`00000000000000_init` is the baseline and is never edited.** It is hand-assembled — trigger
  functions, CHECKs, partial uniques and comments are everything Prisma cannot express — so
  **regenerating it drops every guarantee the database enforces.** New work gets its own
  migration in the same shape; `20260814120000_staff_invitations` is the worked example.
- **No Postgres enums.** Every code set is a `SMALLINT` + CHECK + `COMMENT ON COLUMN` naming
  the set in `@eztruckr/types`. Order comes from a declared sequence, never the numeric value.
- **Code sets are permanent** — never renumbered or reused, append-only.
- **Master data has no `code` column.** Nothing keyed off them. `name` carries the partial
  unique on client, third party, payee, route and expense category; staff carries none.
  `naturalCodeSchema` survives only for `truck.plateNumber`.
- **Soft delete everywhere** (`withDeleted()`, `withHardDelete()`), so uniqueness is **partial**
  (`WHERE "deletedAt" IS NULL`) — 24 such indexes, which Prisma cannot express, so there is no
  `upsert` in the seed.
- **`createdBy` is nullable to Prisma and NOT NULL in Postgres** via CHECK (27 tables; `user`
  and `user_profile` exempt). Filled by an audit extension over AsyncLocalStorage — which **does
  not see raw SQL**, and does not see a `PrismaPromise` awaited outside its `withActor` scope.
- **Money is `DECIMAL(15,4)` in the database, a decimal STRING on the wire.** Never a JSON
  number. currency.js at precision 2. The web app never computes it.
- **Derived, not stored**: `recognisedCost`, `commissionsStale`, `totalAdvanced`, `grossProfit`,
  crew-pay net.

**Counts (verified live):** 34 tables (31 business + 3 Better Auth), 29 `_created_by_required`,
31 `_soft_delete_consistent`, 25 partial uniques, 9 payout triggers, 11 functions, 79
column comments, 195 `uuid` columns, **10 migrations**. `code-constraints.test.ts` asserts
the table count and reads every code CHECK back out of the catalog, so both a new table and a
code appended without a migration fail there rather than at the first write.

---

## The model

### People

One table, `staff`, for everyone who works here.

- `StaffRole` 1 DRIVER · 2 HELPER · 3 DISPATCH_MANAGER · 4 DISPATCHER — what someone may be
  engaged as.
- `CrewRole` 1 DRIVER · 2 HELPER — what they fill on a trip. `commission.role` and
  `commission_rule.role` carry `CHECK (role IN (1,2))` named `*_role_is_a_crew_role`, so **no
  office role can hold a commission** by construction.

**3 and 4 are the office cash holders**: they hold a float without appearing in a slot, so they
cannot be found by reading the trip. `mayHoldTripCashWithoutASlot` asks the PERSON, and is the
one predicate behind the custodian guard, the allowance recipient, the carried deduction and the
web's picker.

**Staff have no natural key** — `staffCode` is gone and two people here can genuinely be called
Jose Santos, so duplicates are accepted and the picker appends phone or email to tell them apart.
**`staff.email` ≠ `user.email`**: contact detail vs the credential, and fixing a typo in one must
never move the other.

**A driver needs both halves of a licence**, number and expiry, on create and update;
`missingLicenceField()` names the blank one. An **expired** licence is still accepted — the
driver slot refuses to dispatch against it.

### The cash trail of a trip

```
Shipment ──┬── Liquidation (one per CASH PILE) ──┬── LiquidationLine     what they spent
           │                                     ├── LiquidationHistory  submissions + returns
           │                                     ├── Allowance           releases booked to it
           │                                     ├── AllowanceRequest    dispatch asking for one
           │                                     └── Settlement          what came back
           ├── BillableExpense      rebilled to the client → revenue
           ├── CompanyPaidExpense   the company paid directly → cost
           ├── AdditionalCharge     fee with no cost → revenue
           ├── ClientPayment        money in from the client → NOT revenue
           ├── Commission           frozen, self-verifying
           └── Adjustment           manual ± to crew pay, with a reason
```

**A liquidation is one account of one trip's cash — one per PILE, not per person.** One row per
shipment blended two people's money: a single `variance` said what the TRIP was short by and never
who owed it. One row per custodian then blended the same person's two vouchers, and left the first
advance unapprovable until the second had been spent. Every action takes a **liquidation id**; only
the lists and the create take a shipment.

- `Allowance.liquidationId` and `Settlement.liquidationId` are enforced by **composite foreign
  keys** on `(liquidationId, shipmentId)`, which is why `shipmentId` stays on both tables. In
  Prisma the target unique uses **`map:`, not `name:`** — `name:` renames only the client-side
  key and leaves drift.
- **`custodianId` is nullable** for exactly one row: the liquidation created at BOOKING. All that
  is unique now is the UNNAMED one — partial unique `(shipmentId) WHERE deletedAt IS NULL AND
custodianId IS NULL` — because two accounts with nobody on them cannot be told apart. A person
  may hold as many as the trip demanded.
- **`sequence` is the account's identity**, 1, 2, 3 on its trip. Allocated max + 1 over the trip's
  accounts **including soft-deleted ones** and never reused, so a settlement or an alert naming
  "account 2" means the same cash a year later; the unique index `(shipmentId, sequence)` is
  therefore **not** partial on `deletedAt`, the one place in the schema where that would be wrong.
  Allocate-and-retry on P2002, exactly as `shipmentNumber` is allocated. `liquidationAccountLabel`
  in `@eztruckr/types` is the one phrasing — "Test Driver's account 2" — used by every screen and
  every refusal, because the custodian's name stopped identifying an account.
- **`description` is optional and load-bearing on nothing** — "Manila leg", "second advance".
  `sequence` identifies an account; this is what makes it recognisable, which is a different job.
  Set on the create or through `PATCH /liquidations/:id/description`, `CAN_SUBMIT_LIQUIDATION` like
  the reference beside it, and frozen by approval with the rest of the record. It is appended to
  `liquidationAccountLabel` where the caller has one — the card, the account pickers and the API's
  refusals — and deliberately not plumbed onto release or settlement rows, which name an account by
  number.
- **Who received cash ≠ who answers for it**, and **a custodian need not be on the truck** —
  `assertMayHoldTripCash`, for all three callers.
- **Holding a float and editing one are different permissions.**
  `assertMayAccountForThisFloat` confines CREW, OPERATIONS and DISPATCH_MANAGER to their own
  accounts; ADMINISTRATOR and ACCOUNTING act on any and hold none. The **unnamed** account admits
  whoever is in a slot and nobody else — an office cash holder holds nothing until somebody with
  `CAN_WRITE_SHIPMENT_MONEY` names them to it.

**An `AllowanceRequest` is the ask; the `Allowance` is still the money.** Dispatch may not
release cash — that control is `CAN_WRITE_SHIPMENT_MONEY` and it stays — so a dispatch manager
raises a request and accounting approves it. Approval writes an **ordinary allowance**, on the
same account, in the same `totalAdvanced`: nothing downstream of a release knows this table
exists. `allowance` gained no column; the join is `allowance_request.allowanceId`, partial-unique.

- **Approve as requested, or decline with a reason.** There is no amount on the approval payload.
  Releasing less is a refusal of _this_ ask, not an approval of a different one, and "approved"
  beside a figure nobody agreed to is what the record exists to prevent.
- **Proof is REQUIRED for a transfer or an e-wallet payment**, optional for cash —
  `expectsProofOfRelease`. Deliberately stricter than the direct-release path and deliberately
  unlike `expectsReferenceNumber`: a reference is _typed_, so requiring one yields "N/A"; a
  receipt is _uploaded_, so requiring one yields the document or a refusal. It applies here
  because the person who asked and the person who paid are two people.
- **The decision shape is a CHECK**, `allowance_request_decision_matches_status`: PENDING carries
  no decision at all, APPROVED must name its release, DECLINED must say why. In the database
  because an approved request pointing at no release is untraceable cash, and no amount of care in
  a service reliably prevents it. `allowance-request.test.ts` proves it with raw SQL.
- **`purpose` is NOT NULL — the only mandatory free text in the system.** Every other such column
  is `remarks`: an optional note on something that already happened. This one IS the ask, and
  accounting decides on it without running the trip. `requiredText`, not `optionalText`, because
  that helper collapses a blank to null and would have admitted an empty one. The approval's own
  `remarks` stays optional and annotates the PAYMENT; a release inherits the purpose when it is
  left blank.
- **A PENDING ask can be corrected; a decided one never can.** `update` is `.partial()` and
  re-runs the create's guards for whichever fields moved — an account can be approved and a crew
  member swapped between raising and correcting. Editing a decided request would rewrite what
  accounting answered: an approved one has a release beside it that would then disagree, and a
  declined one would leave its reason attached to a figure nobody refused.
- **`editedAfterRaising` is derived from `updatedBy`, not from the clocks.** Approval carries no
  amount of its own, so an approver who read the queue before an edit has nothing to check
  against; the flag is what tells them. `updatedAt` vs `requestedAt` was the obvious derivation
  and is a guess — one is Prisma's clock, the other Postgres's, and they disagree by milliseconds
  on an untouched row. The audit extension forces `updatedBy` to null on create, which makes it
  exact. PENDING-only, since deciding is an update too.
- **No CANCELLED code.** Withdrawing a pending ask is a soft delete; `deletedBy`/`deletedAt`
  already answer the only question a fourth status would.
- **Approval is terminal, with no reversal.** There is nothing to reverse — the money moved, and
  unwinding it is the `Allowance`'s own removal. A reversible approval would be a second, quieter
  way to undo a cash release.

**Merging any pair is the tempting mistake.** An allowance is a receivable, never a cost; a
billable expense is revenue whose cost lands wherever the money left, so counting both
double-counts; an adjustment is never an edit to a `Commission`, which states its own arithmetic
so a voucher is re-derivable a year later.

### What the client has paid

**A `ClientPayment` is the mirror of an `Allowance`, and is not revenue.** Revenue is recognised
when the trip runs; this is its COLLECTION. Counting a payment as income double-counts the freight
and makes a trip's profit depend on how fast the client's accounts payable department moves —
`grossProfitSchema` names it among the deliberate absences, beside the allowance and the gas
deduction.

- **One row per payment, never an `amountPaid` field.** A downpayment at booking and the balance
  thirty days later are two movements; a field would be overwritten by the second and the first
  would lose its date, method and check number. The same argument that keeps `totalAdvanced`
  derived.
- **What is owed is derived, by the same function gross profit uses.** `shipmentRevenue()` is the
  one place that says `netRate + billableExpenses + additionalCharges`, so an invoice chased on one
  figure and a margin reported on another cannot happen. `client-payments.test.ts` asserts
  `amountDue === grossProfit.revenue` against the other service rather than against a literal.
- **`PaymentStatus` is a string union, not a code set** — the `RemovalOutcome` rule: a code set is
  a SMALLINT with a CHECK behind it, and this is never written to a column. **Nothing received is
  checked first**, so an unbilled trip reports UNPAID rather than "paid in full" beside its zero
  balance. **OVERPAID is reported, not refused**: one check applied to the wrong trip is real, and
  what is owed moves on its own as charges are recorded.
- **A payment may be recorded at ANY status, CLOSED included** — the deliberate difference from an
  allowance, which a closed trip refuses. Thirty- and sixty-day terms mean the check routinely
  arrives after the crew were paid and the trip closed, so refusing it would make the LAST payment
  on every trip the one that cannot be recorded. Symmetrically, **closing does not require the
  client to have paid**: `assertReadyToClose` asks about the crew's cash and deliberately not the
  client's, or a crew payout would wait on somebody else's accounts payable.
- **`PaymentMethod` is its own code set, not `DisbursementMode` widened.** The first three codes
  agree; the fourth, CHECK, is how a Philippine corporate client settles a hauling invoice.
  Folding it into BANK_TRANSFER means a check number in a field labelled "transaction reference",
  and widening the shared set would say a crew allowance may be released by check.
- **A refund and a bounced check are the removal of the row**, not a negative one — the soft delete
  already records who reversed it and when. `client_payment_amount_positive` backs it up.
- **No payer column and no denormalised `clientId`.** The trip names its client, and the composite
  key `Allowance` uses would have frozen it — a trip filed under the wrong client stays correctable
  until it is liquidated, deliberately.
- **Crew see none of it**, by absence from the read list rather than by redaction, and a payment's
  proof is likewise absent from `ATTACHMENT_INCLUDE` — but present in `referenceCount`, or the
  orphan sweep would hard-delete it. That asymmetry is the point and is commented on both.

### Recording a payment, and checking it

**DISPATCH_MANAGER records; ACCOUNTING verifies.** The person who moved the freight is routinely the
first to hear the client paid for it; the person holding the bank statement is somebody else.
`CAN_RECORD_CLIENT_PAYMENT` is the one write list here wider than `CAN_WRITE_SHIPMENT_MONEY`, because
a client's payment is not DECIDED by anybody — it happened. `role-policy.test.ts` asserts the two
lists stay disjoint on at least one role; without that, nothing ever enters the queue and the state
is decorative.

**This is not the float control being relaxed**, and it looks enough like it to be worth saying. A
dispatch manager is kept out of `CAN_WRITE_SHIPMENT_MONEY` because they hold trip cash and releasing
it would let them pay themselves — a rule about money going OUT to the crew. A client's payment comes
IN, reaches nobody's pocket, moves no variance, and is unverified until accounting says otherwise.
OPERATIONS is absent on the payee/rate-chain reasoning: the supervisor answers for what was sold.

`PaymentVerificationStatus` 1 UNVERIFIED · 2 VERIFIED · 3 RETURNED, on the payment row rather than in a
second table. **The liquidation's shape, not the allowance request's**: there is no ask preceding the
money — the cash arrived, and what is in question is the RECORD of it.

- **An UNVERIFIED payment counts as collected; a RETURNED one does not.** The first is the same call
  `GrossProfit` makes about a running liquidation — money a client demonstrably sent does not become
  less sent while it waits for a tick, and a receivables figure lagging accounting's queue has people
  chasing clients who already paid. The second is the asymmetry: unverified means nobody has looked,
  returned means somebody looked and said they could not match it. The summary reports
  `amountVerified` and `amountReturned` beside `amountPaid` so none of the three is read as another.
- **Who recorded it decides whether it needs checking.** A dispatch manager's entry joins the queue;
  an accountant's own is VERIFIED on the spot and stamped to them. Not a hole — the queue holds work
  needing a SECOND pair of eyes, and one padded with self-evident rows gets bulk-cleared without
  reading. `verificationOnWriteBy` is the single predicate, consulted by create and edit alike.
- **Verification freezes the row against whoever cannot verify** — a liquidation frozen by its own
  approval, same shape. Without it the control is theatre: record something unremarkable, wait for the
  tick, change the amount. Accounting may still edit, and their edit re-stamps the check.
- **A return goes back to UNVERIFIED when answered**, so accounting sees it again rather than having
  to remember it, and the amount rejoins `amountPaid`. `client_payment_verification_matches_status` is
  the CHECK: UNVERIFIED carries no decision, VERIFIED names who and when with no note, RETURNED
  requires the note. Same verb, same required reason and same endpoint shape as returning a
  liquidation to the crew — `POST /client-payments/:id/return`.
- **A returned payment is CORRECTABLE from the screen**, which is what makes the return a loop
  rather than a dead end — the first cut shipped the decision with no edit affordance, so accounting
  could hand a payment back and the recorder's only route was delete-and-retype, throwing away the
  original row. One `PaymentForm` serves both recording and correcting so the two cannot drift, and
  the API decides what the edit does to the verification state.
- **Verifying twice is REFUSED, not idempotent.** There is no history table, so a second stamp would
  not record that two people looked — it would erase the fact that the first one did, with nothing
  saying so. The screen hides the button and the service throws. Accounting who doubts an earlier
  check returns the payment for correction, which is recorded.
- **The dashboard queue is not a nicety.** Accounting has no way to know which trips picked up a
  payment this morning, so a per-trip card alone would mean checking by memory or not at all.
- **`CAN_UPLOAD_RECEIPTS` survives as an alias of `CAN_SUBMIT_LIQUIDATION`** only because the dispatch
  manager was already in it, for their own float. A recorder who was not would have to break the alias
  rather than be added to it — attaching a document is not submitting somebody's cash account.

---

## Development

### First run

`docker compose up` migrates and stops — no seed, no accounts. `/setup` names the first
administrator, who is emailed an invite like everyone else. `GET /system/status` and
`POST /system/initialize` are `@Public()`, since there is nobody to authenticate as yet.

**A failed invite rolls the whole thing back** — `503`, flag unstamped, account soft-deleted, the
address reusable via the partial `user_email_live_key`. Delivery failures are _recorded_ rather
than raised everywhere else, because an admin can see `deliveryError` and resend; here the admin
IS the failed invite and the token is hashed, so a stamped flag meant recovery only through
`psql`. `assertTheInviteWasDelivered` runs before the claim.

**`system_setting.initializedAt` closes that endpoint and is STORED, not derived**: "an
administrator exists" would reopen a public administrator-minting endpoint the moment the last
one is removed. The claim is one statement, which makes it a control rather than a check:

```sql
INSERT INTO system_setting (id, "initializedAt", ...) VALUES ('singleton', NOW(), ...)
ON CONFLICT (id) DO UPDATE SET "initializedAt" = NOW(), ...
  WHERE system_setting."initializedAt" IS NULL
RETURNING id
```

Exactly one of two concurrent requests gets a row back; the loser's half-made administrator is
soft-deleted. The pre-check before it **is not the control** — the concurrency test holds both
callers at a barrier past it, or they serialise and deleting the guard still passes. The
bootstrap administrator's `user` row has `createdBy = NULL`, the one column the schema permits
it on.

### Inviting a staff member

`POST /users` provisions an account with **no usable password** and emails a link; the invitee
chooses the password, and that acceptance is their first sign-in.

| Step          | What happens                                                         |
| ------------- | -------------------------------------------------------------------- |
| Create        | Account made, `emailVerified: false`, invitation minted, email sent  |
| Before accept | Sign-in refused — `hasUnacceptedInvitation`, in the Better Auth hook |
| Accept        | Sets the password, flips `emailVerified`                             |
| Resend        | Mints a NEW token and revokes the old                                |
| Revoke        | Withdraws the link; the account stays shut                           |

- **`staff_invitation.tokenHash` is a SHA-256**, never the token — deliberately no salt and no
  KDF, the opposite of the password rule: 32 random bytes have nothing to brute-force.
- **One pending invite per login**, by `staff_invitation_pending_user_live_key`, which is what
  makes resend honest: it must revoke before inserting, so a forwarded link dies.
- **The gate runs BEFORE the password check**, so right and wrong passwords get the same answer
  on an unactivated account, and REVOKE means something. Any ACCEPTED invitation opens the
  account; a login with **no** invitation is left alone.
- **A failed email does not fail the request.** `MailService` returns a result; `deliveryError`
  records why and the screen offers Resend.
- **`POST /users/:id/password` survives as break-glass.** No longer how an account starts.

**Mail is Resend over `fetch`**, no dependency. With no `RESEND_API_KEY` sending FAILS;
`MAIL_LOG_INSTEAD_OF_SENDING=true` logs the message and its link instead. **That flag must not be
derived from `NODE_ENV`** — the compose stack runs `NODE_ENV=production` because it builds
production images, which would disable the fallback exactly where it exists for.

**Four URLs move together** off this laptop: `APP_BASE_URL` and `CORS_ORIGINS` (web origin),
`BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` (api origin). Change one alone and an invite lands on
a page that cannot reach its API, or sign-in succeeds and the session evaporates.
`NEXT_PUBLIC_API_URL` is compiled into the client bundle, so it needs `docker compose build web`,
not a restart.

### Two databases

| Database        | What it is                     | Migrated | Seeded              |
| --------------- | ------------------------------ | -------- | ------------------- |
| `eztruckr`      | development — yours to play in | on boot  | **never**           |
| `eztruckr_test` | the suites'                    | on test  | on test, every time |

`prepareTestDatabase()` derives `<name>_test` from `DATABASE_URL` (or `TEST_DATABASE_URL`),
creates, migrates and seeds it; both vitest projects put that URL in `test.env`. **It refuses any
name not ending `_test`**, because everything downstream deletes rows in whatever it is pointed
at. It takes a **Postgres advisory lock** on the `postgres` maintenance database: turbo runs both
projects in parallel and on a cold database both race to seed — `migrate deploy` holds its own
lock, the seed does not.

`docker compose down -v` takes `eztruckr_test` with it; the next `pnpm test` rebuilds it. The
seed keeps its committed passwords (`admin@eztruckr.ph` and two staff logins) and **is the test
fixture now**; `pnpm db:seed` gives development demo data. Suites share the test database,
isolated by a reserved **uuid block** each — `testUuid(block, name)` fixes the first 32 bits. `00000001` `packages/db` (deleted wholesale) · `00000002`
liquidation-lifecycle · `00000003` shipment-booking · `00000004` truck-assignment · `00000005`
trip-profit · `00000006` adjustments · `00000007` invitations · `00000008` system · `00000009`
crew-licence. Cleanup matches child rows **by relationship, not by id**.

**Cleanup suspends the payout triggers only via `withTriggersSuspended`.**
`session_replication_role` is per-CONNECTION and Prisma pools, so `SET replica` / deletes /
`SET DEFAULT` as loose statements can leave one connection with **every trigger disabled for the
rest of the run** — assertions then pass or fail by which connection served them. The helper pins
them to one connection and uses `SET LOCAL`, which reverts on commit and rollback. It cost CI four
red trigger-backed assertions that passed on every laptop; CHECKs and unique indexes kept passing
throughout, because `replica` suspends triggers only.

### Where the machinery already is

| Need                                  | Use                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Money arithmetic                      | `money()`, `multiplyByRate()`, `sum()`, `toDecimalString()` in `@eztruckr/types` |
| Exact arithmetic, no 2dp rounding     | `apps/api/src/commission/rational.ts`                                            |
| Reference-aware removal               | `apps/api/src/master-data/removal.ts` — probe, then deactivate vs delete         |
| Whether a payee is required           | `apps/api/src/master-data/payee-requirement.ts`                                  |
| Role policy                           | `apps/api/src/auth/role-policy.ts` — declared once, never inline                 |
| Sending any email                     | `apps/api/src/mail/mail.service.ts` — returns a result, never throws             |
| Whether a login may sign in yet       | `apps/api/src/users/invitation-gate.ts`                                          |
| Standing up the test database         | `packages/db/src/test-database.ts`                                               |
| Soft-delete escape hatches            | `withDeleted()`, `withHardDelete()`                                              |
| Single live row from a partial-unique | `liveOne()` / `liveOneOrThrow()`                                                 |
| Row → response conversion             | `apps/api/src/master-data/serialize.ts`                                          |
| Declarative master-data screens       | `apps/web/src/lib/resource-spec.ts` + `resources.tsx` — eight of them            |
| Uploads                               | `StorageService` + `ReceiptsService`                                             |
| Trip- and account-level read scoping  | `apps/api/src/liquidation/shipment-access.service.ts`                            |
| Who may hold a trip's cash            | `apps/api/src/liquidation/trip-cash-participants.ts`                             |
| The same list, for the web's pickers  | `apps/web/src/components/shipments/trip-cash-holders.tsx`                        |
| Whose account a session may edit      | `assertMayAccountForThisFloat` in `liquidation.service.ts`                       |
| Who may open which web screen         | `PAGE_ROLES` in `apps/web/src/lib/nav.ts` — nav and `ResourcePage` both          |
| DB-backed service tests               | `apps/api/src/liquidation/liquidation-lifecycle.test.ts` — the pattern           |

### Still worth doing

- **An API e2e harness (supertest).** The biggest hole: `crew-visibility.test.ts` pins the
  redaction against a controller instance, but that a 403 actually comes back is proved only by
  hand — it needs the Nest request pipeline.
- **The web app has no tests.** `PayeeField`, the rate-chain and commissions cards and
  `/accept-invite` all render conditionally. The API is the control in every case.
- **No invite email has ever been sent by Resend.** A key is in `.env`, but
  `MAIL_LOG_INSTEAD_OF_SENDING` is still on and `MAIL_FROM` is the shared sandbox sender, which
  only delivers to the address owning the account. Inviting anyone else needs a verified domain.
- **No payout-run builder exists at all**, so no carried debt is recoverable yet. Its population
  predicate must be a **union**: unpaid commissions ∪ unpaid adjustments ∪ outstanding
  `CrewDeduction`s — `PayoutLine.commission` is already nullable.
- **`CommissionService.computeForShipment` has no test**, only live verification.
- **Phase 9's screens have still not been clicked through** — the dispatcher's screens, the
  rate-chain correction form and the dispatch manager's transition buttons. The build is now the
  Phase 9 one everywhere (production runs it), so this is unexercised UI rather than a stale
  container.
- **R2 writes are proven, not just `HeadBucket`.** 17 real receipts uploaded through the app
  (verified: object listing matches `receipt` rows, filenames are forwarded phone photos) and
  `backup.sh` has completed against production (verified: 211 KB landed and was listed back).
  `WHEN_REQUIRED` and the scoped token are confirmed correct in both directions, not assumed.
- **Known flake, open.** `adjustments.test.ts > survives a recompute…` and one whole api-suite
  run, neither reproducible since. Both smell like cross-suite interference through global master
  data in the shared test database.

---

## How this codebase expects to be worked on

- **Structural enforcement over convention.** If a rule matters, make it a constraint, a trigger
  or a type. The pattern that has caught bugs in four phases: **if no CHECK can express the rule,
  the schema is probably missing a column.**
- **One column, one job.** Four separate defects have been the same shape.
- **Never invent a number.** Every failure in the money path refuses and says why.
- **Freeze what a figure depended on** onto the row it produced. Anything `applied*` is one of
  those copies, written only by the engine.
- **Comments explain why, not what** — most long docblocks exist because the obvious alternative
  is wrong for a reason not visible locally.
- **`pnpm run check` is the gate**: format, lint, typecheck, test, every workspace. Green at
  every commit since Phase 4.
- **Verify against the running stack.** A serializer once filtered `eligibleRoles` through the
  wrong code guard: it typechecked, passed 154 tests, and served an empty role array. One API
  call found it.

### Rebuilding, and the traps

Containers are **baked images, not mounts**, and the api image BAKES the migrations. Check what
is actually running with `docker inspect eztruckr-web --format '{{.Image}}'`.

```bash
docker compose down -v && docker compose up -d --build
```

**`--build` is not optional** — a plain `up -d` re-applies the migration from the last image and
you debug an edit that never ran. It can also **fail silently**, leaving the OLD container up,
which looks exactly like "my change did nothing". When a change refuses to appear, build alone
with `--force-recreate`: compose does not always replace a container whose tag is unchanged.

```bash
docker compose build web && docker compose up -d --force-recreate web
```

If a migration is wrong **after** being applied and a reset is unacceptable: hand-write the
inverse DDL in one transaction ending with
`DELETE FROM "_prisma_migrations" WHERE migration_name = '<name>'`, fix the file, then
`prisma migrate dev`. **That can hang** on an interactive prompt here; it applies the migration
first, so kill it, run `prisma migrate deploy`, and confirm with
`prisma migrate diff … --exit-code`.

**`incremental` and `deleteOutDir` were fundamentally incompatible on the api**, and it presented
as `Cannot find module './auth/auth.module'` from `pnpm dev` — a runtime error, never a build one.
`nest start --watch` wipes `dist` on every start; the build state sat at the package root and
survived, so tsc was asked to emit into an empty directory while holding a record saying every
file was already up to date. **It emitted nothing and exited 0.** Fixed by moving
`tsBuildInfoFile` INTO `dist` (`apps/api/tsconfig.json`), so deleting the output deletes the
record of having produced it. If a stale one is ever suspected, `find . -name '*.tsbuildinfo'`
and delete — a build that emits zero files and succeeds is always this.

**`.dockerignore` already excluded `**/*.tsbuildinfo` for the same reason**, in a comment
describing the same silent no-emit. The image path was defended and the local one was not, which
is the recurring shape here: **the guard sat where somebody had already been burned.**

**Housekeeping — and it does not look like a disk problem.** The Docker VM has run out of disk
**five** times, most recently with postgres crash-looping on
`PANIC: could not write to file … No space left on device`. That presented as _"sign-in fails
with the correct password"_ and as every DB-backed test failing at global setup, and an hour can
go into the auth code first. The tell is `FATAL: the database system is in recovery mode` in the
API log; postgres recovers on its own once there is room.

```bash
docker exec eztruckr-api df -h /
```

Two prunes, in this order, reclaimed 50GB of a 59GB disk at 100%: `docker builder prune -af`
(all build cache — regenerable, and a failed `compose build` leaves gigabytes of it), then
`docker image prune -f` (**dangling only**). **Never `docker image prune -a`**: that deletes
unused TAGGED images and reaches into the user's other projects.

### The web image, on Next 16

`output: 'standalone'` traces the runtime's `node_modules`, and under pnpm it copied **half** of
`@swc/helpers` — the `cjs/` files its CJS resolution found, not the `esm/` ones that package's
`exports` map answers with under `module-sync` and `import`. Next's own require-hook asks for the
latter, so the build passed, the image built, and `server.js` died at its first require with
MODULE_NOT_FOUND. `outputFileTracingIncludes` in `next.config.ts` forces the whole package in.
**Only starting it finds this** — `next build` and `pnpm run check` are green either way.

`next dev` also writes `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`, re-creating them every run,
so they are kept rather than deleted; `agentRules: false` turns them off.

---

## Decision record

Kept so a later session sees what was decided rather than reopening it.

| Question                                                | Decision                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `appliedTpcRate` semantics                              | Rate **or** flat amount, never both.                            |
| `Commission.appliedRate` nullable for fixed/formula     | Correct — a REPORTED rate, not an operand.                      |
| Charges editable after computing, until **paid**        | Correct as built.                                               |
| Crew debts written off?                                 | **Never.** Recovered in full or carried indefinitely.           |
| Who may release cash                                    | ADMINISTRATOR + ACCOUNTING only.                                |
| Office roles submitting on the crew's behalf            | Allowed; history names whoever acted.                           |
| Which crew member a carried balance is charged to       | **Ask.** Never default to the driver, or to the custodian.      |
| `requiresReceipt`                                       | Stated, not enforced — the approver judges a lost ferry ticket. |
| Variance in the crew's favour                           | **Paid immediately**, never carried to a payout run.            |
| Orphaned receipts                                       | `POST /receipts/sweep-orphans`, object first then row.          |
| Does a dispatch manager earn a commission?              | **No** — enforced by the crew-role CHECK.                       |
| May they approve or release?                            | **No.** They are custodians; it would be their own float.       |
| Are they scoped like crew?                              | Only for liquidations. They read every trip.                    |
| May a dispatcher hold a trip's float?                   | **Yes.** `StaffRole.DISPATCHER` (4), appended for it.           |
| Reuse DISPATCH_MANAGER for them instead?                | **No** — it carries master data a dispatcher may not keep.      |
| Must a dispatcher's login name a staff row?             | **Yes**, like the other two cash holders. Backfilled.           |
| Who may edit a dispatcher's liquidation?                | Them, plus ADMINISTRATOR and ACCOUNTING. Not a colleague.       |
| May a dispatcher keep clients, trucks, payees?          | **No** — their manager does. Routes are the exception.          |
| May either dispatch role edit `staff`?                  | **No.** It decides who may hold cash.                           |
| May the gross rate be corrected after DRAFT?            | **Yes**, until a commission is paid, by admin or DM.            |
| May client, date, route or container be fixed after it? | **Yes**, to LIQUIDATED — client and route also stop at paid.    |
| Cargo description too, since it is the same form?       | **No.** Not asked for, and it is a term of the booking.         |
| Should `Payee` replace `ThirdParty`?                    | **No.** Opposite sides of the ledger — see below.               |
| Can a payee be a member of staff?                       | **No.** External only; cash to crew is an `Allowance`.          |
| Is `payeeId` required on an expense?                    | **The category decides.** `ExpenseCategory.requiresPayee`.      |
| Is `requiresPayee` enforced, like `requiresReceipt`?    | **Yes** — the only one of the two that is.                      |
| Is "Paid to" hidden when not required?                  | **No.** Always shown; only requiredness varies, never by role.  |
| What a crew member sees of a trip's money               | **Nothing.** Not the base, not their own commission.            |
| How the FIRST administrator is created                  | `/setup`, once, then invited by email like everyone else.       |
| Is "initialised" derived from "an admin exists"?        | **No — stored.** Deriving it reopens a public admin endpoint.   |
| Does the seed run in development?                       | **No.** It is the test fixture.                                 |
| How a staff member gets their password                  | **They set it**, from an emailed invite. Never an admin.        |
| Mail transport                                          | **Resend over `fetch`** — no npm dependency, no SMTP container. |
| Invite token in the database?                           | **Hash only.**                                                  |
| Do master-data tables need a `code`?                    | **No.** Nothing keyed off them; `name` carries the unique.      |
| Should staff keep theirs?                               | **No** — decided against the recommendation. See People.        |
| Should `staff.email` and `user.email` be one column?    | **No.** Credential vs contact detail.                           |
| Does a driver need a licence EXPIRY, not just a number? | **Yes, both.** Half a licence used to save and fail later.      |
| Is an expired licence rejected on the staff record?     | **No.** A fact worth recording; the driver slot refuses.        |
| One hostname, or an `api.` subdomain?                   | **One.** Four URL settings collapse to one; cookie first-party. |
| `eztruckr.` or `eztruckr.apps.`?                        | **Flat.** Universal SSL stops at first-level; deeper needs ACM. |
| Origin cert: Cloudflare CA or Let's Encrypt?            | **Cloudflare, 15 yr.** DNS-01 wants a token covering mail too.  |
| Postgres image: Alpine or Debian?                       | **Debian.** musl sorts text by byte order whatever it reports.  |
| Build images on the droplet?                            | **No.** GitHub Actions builds; the droplet only pulls.          |
| Pin `container_name` in prod?                           | **No.** Global, not project-scoped — blocks a second stack.     |
| Migrations from the API's entrypoint?                   | **No.** Own step, or a bad one crash-loops behind a green run.  |
| DNS at DigitalOcean instead of Cloudflare?              | **No.** The proxy is what the origin cert and edge TLS rest on. |

### Payees are not third parties

|             | `ThirdParty`                           | `Payee`                                |
| ----------- | -------------------------------------- | -------------------------------------- |
| What it is  | broker who BRINGS freight              | supplier money is DISBURSED to         |
| Money       | netted off gross (`gross - tpc = net`) | a cost row, paid out                   |
| Disbursed?  | **never**                              | that is the whole point                |
| Carries     | `defaultCommissionRate`                | address, TIN — voucher fields          |
| Points from | `shipment.thirdPartyId`, one per trip  | liquidation lines + company-paid, many |
| Locks on    | leaving DRAFT                          | its liquidation's APPROVED             |

Merging them puts a nullable rate on rows that can never use it — the "one column, two jobs"
shape behind four defects here. **`PayeeType` has no STAFF code**, same reason: cash to a crew
member is an `Allowance` naming a `Staff`. `billable_expense` has **no payee at all**.

### "Paid to" — the flag is frozen onto the row

`ExpenseCategory.requiresPayee` decides, defaulting to **true** so a new category is strict until
relaxed. One resolver, `payee-requirement.ts`, for both callers.

**`payeeRequired` is copied onto every row** because a CHECK cannot reach across tables, and a
trigger reading `expense_category` at write time would enforce the category's CURRENT value —
flipping one to required would retroactively invalidate every row ever written under it.
`liquidation_line_payee_required` and `company_paid_expense_payee_required` pair the frozen flag
with the payee. Consequence: an **edit** re-stamps the row under the current rule, so correcting
an old row can demand a payee it never had — `trip-profit.test.ts` pins both halves. Making it
mandatory deleted 22 liquidation lines rather than backfilling, and recomputed `totalLiquidated`
and `variance`: **attributing a purchase to a supplier nobody recorded is inventing a fact**.

### Two standing "do not"s

- **Do not add an `isSettled` column or a write-off amount to `CrewDeduction`.** Settlement is
  derived (recoveries sum to amount); a partly-recovered debt stays open. If the business ever
  forgives debts, that is its own record with a reason and an approver.
- **Do not reimburse a negative liquidation variance through an `Adjustment` (INCREASE).** It
  would make somebody wait for a payout run to be repaid money out of their own pocket.
  `settlement_carry_is_a_debt` enforces this in the database.

---

## Phase history

Only what the sections above do not already carry; `git log` has the rest.

**1** compose + MinIO · **2** data model, enums → smallint + CHECK · **3** Better Auth,
`RolesGuard` fails closed, `role`/`staffId` are `input: false` · **4** the money engine, one
place multiplies a base by a rate, no fallback in rule resolution · **5** allowance /
liquidation / receipts / settlement · **6** `235d11c`…`f3f8759` many liquidations per shipment,
`crew_member` → `staff` · **8** `565979a` invitations, `/setup`, no dev seed.

**Lessons worth the space:** guards keyed on **computed** rather than **paid** made a late charge
unfixable, and `assertNothingPaid` is the correct line (4). Costs are **recognised, never
posted**, which makes "return → resubmit → approve posts exactly one set of costs" true by
construction (5).

**7** `1cb8dd8` — payees and **Postgres 18 + UUIDv7** on every table. Only live verification
caught what the type change broke: the `lastLoginAt` raw update needed `::uuid` (every sign-in
500'd), `eztruckr_commission_is_paid` needed a `uuid` parameter (payout guards silently stopped
resolving), and `audit_log.entityId` stays **text** because it is polymorphic.

**9** `7e75fd8` — the dispatcher becomes a cash holder and loses the directories; Next 15 → 16.
Four defects, one shape: **the control sat where the UI happened to look.** The one not described
above: `crew-and-lifecycle-card.tsx` hand-copied a role list and omitted DISPATCH_MANAGER from
`canDispatch`, so every dispatch button was dead for the role whose job it is, while the API
allowed it throughout.

**Deploy** `7e75fd8`…`3122b22` — shipped to production. Every defect it surfaced was invisible to
`pnpm run check` and cost a green-but-wrong run: R2 rejecting the SDK's default checksums, `/setup`
stamping its flag on a failed invite, a pooled connection left with triggers disabled, and a
release script eating itself from stdin. **The pattern: each layer behaved exactly as designed,
and the failure lived between two of them.** Conventional Commits from `3122b22` on.

**10** — the paperwork fields. `shipment.shipmentDate` and `containerNumber` (searched alongside
the number and the lane), reference numbers on the liquidation and both expenses, the allowance's
own `issuedAt` finally offered on the form, and `BillableExpense` given the fields
`CompanyPaidExpense` already had. Every delete on the money screens now asks first, through one
`ConfirmDeleteButton` that renders its own trigger so a card cannot place the button without the
question — each had wired a bin icon straight to its mutation while master data and users had
confirmed all along.

**11** — allowance requests: dispatch asks, accounting releases and attaches the proof. One new
table, no column on `allowance`, and nothing downstream of a release changed. The design notes are
under _The cash trail of a trip_; the two calls worth restating are **approve-as-requested** (a
smaller release is a decline, not an approval) and **proof required for transfer and e-wallet**,
which is the first rule in this codebase to demand an attachment — justified because the ask and
the payment are made by different people.

**12** — client payments: what has actually been collected for a trip. One new table, one new code
set, and nothing in the P&L reads either — the design notes are under _What the client has paid_.
The refactor it forced is the useful part: `shipmentRevenue()` now states the revenue sum once for
both the margin and the invoice, and `repeatedReferenceNumbers()` states the duplicate-reference
rule once for both allowances and payments. Fixed in passing: `ReceiptsService.referenceCount`
omitted `company_paid_expense`, so the orphan sweep could hard-delete a receipt a live expense was
still showing.

**13** — payment verification. Dispatch records what a client paid; accounting checks it against the
bank. No new role and no new table — a state on the payment row, in the liquidation's shape. Design
notes under _Recording a payment, and checking it_; the two calls worth restating are **unverified
money still counts** and **an accountant's own payment never enters the queue**.

---

## Production

**[DEPLOYMENT.md](DEPLOYMENT.md)** is the runbook; the shape and the rejected alternatives are in
the decision record. One DigitalOcean droplet (SGP1, Ubuntu 26.04, 1 vCPU/1 GB + 2 GB swap;
measured idle footprint ~220 MB), Cloudflare DNS + R2, GitHub Actions → GHCR → SSH. Deploying is
`git push`. Caddy fronts both apps on one hostname, split on `/api`.

Four traps, each of which produced a **green run and a broken result**:

- **`WHEN_REQUIRED` checksums in `StorageService`.** The SDK's default since v3.729 sends a CRC
  trailer R2 rejects — while `/api/health` still says storage `up`, because `HeadBucket` carries no
  body. `backup.sh` sets the CLI's equivalent.
- **The release script is read from bash's stdin**, so any command in it that reads stdin eats the
  rest and bash exits 0 half-done. Hence `-T </dev/null` on `compose run` and the
  `__RELEASE_COMPLETE__` sentinel the step fails without. Same step: `|| true` on the crontab
  `grep -v`, which exits 1 on an empty crontab and killed it under `pipefail`.
- **`docker-compose.prod.yml` is not a layer over `docker-compose.yml`** — it pulls tagged images
  and publishes only 80/443.
- The droplet's `.env` is regenerated from GitHub secrets every deploy; hand edits are reverted.

The origin certificate expires in **15 years with no auto-renew**; the browser-facing one is
Universal SSL and renews itself. An uptime check on `/api/health` is what turns that eventual 526
into a page — and it must match `"status":"ok"` in the **body**, since the endpoint answers 200
even when degraded.

---

## Tech stack (per brief, one substitution)

Turborepo · Docker Compose · **Next.js 16** App Router · shadcn/ui + Tailwind v4 · TanStack
Query · NestJS · Prisma · **PostgreSQL 18** · currency.js · MinIO (R2 in prod) · Better Auth
1.6.26. Caddy fronts production.

PostgreSQL 18 against the brief's 16 is the one deviation, for `uuidv7()`. **No dependency added
since Phase 3**: exact arithmetic is a hand-written BigInt module, uploads use
`@nestjs/platform-express`'s `FileInterceptor` and the Phase-1 `@aws-sdk/client-s3`, and mail is
Resend's HTTP API over `fetch` — hence no nodemailer and no SMTP container.
