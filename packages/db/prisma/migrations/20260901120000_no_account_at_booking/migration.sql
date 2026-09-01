-- BOOKING NO LONGER OPENS AN ACCOUNT, and this migration is only the column
-- comment catching up with it. No DDL: `custodianId` was already nullable and
-- stays that way — what changed is WHY, and a comment that still says "created
-- at booking" is a database describing behaviour the code stopped having.
--
-- Booking used to create one liquidation with nobody named to it. The reasoning
-- was that a crew spends money from day one and needs somewhere to record it,
-- which is true, and the row it produced was still an ACCOUNT WITH NO
-- CUSTODIAN: every trip carried one whether anybody ever held its cash or not,
-- and a release landed on it by default. That default is how a helper's ferry
-- money reached the row that later became the driver's — the blending the
-- per-custodian split exists to prevent, reintroduced by the convenience.
--
-- An account now arrives with the person answerable for it: named to a helper
-- when the crew are assigned, opened by hand for anybody else. The one
-- remaining automatic unnamed account is the backstop at DELIVERY, for a trip
-- that reached the end with none at all — at that moment the crew are holding
-- receipts, and a row somebody can be named to beats refusing the paperwork.
COMMENT ON COLUMN liquidation."custodianId" IS
  'The staff member answerable for accounting for this cash. Nullable for one case: the account the delivery backstop opens for a trip that reached the end with none at all — booking opens nothing, so an unnamed row means the crew came back with receipts before anybody was made custodian. NOT the same as an allowance''s recipient: a helper can be handed ferry money the driver remains answerable for. Not necessarily on the truck either — a dispatch manager holds a trip''s float without driving or helping. Not unique on the trip: one person may hold several accounts on one trip, successive advances against successive vouchers, and `sequence` is what tells those apart. Only the UNNAMED account is limited to one live row per trip.';
