import { z } from 'zod';
import { isoDateTimeSchema } from './common';
import { operationExpenseCategoryTotalSchema } from './operation-expense';

/**
 * What the BUSINESS made over a period, as opposed to what a trip made.
 *
 * THE QUESTION THIS ANSWERS IS "WHAT DID WE MAKE IN AUGUST", and until it
 * existed the system could not. `GrossProfit` answers it one trip at a time and
 * deliberately stops there — overhead belongs to no shipment, so a trip's
 * margin cannot contain it — which left the company-level figure living in a
 * spreadsheet somebody rebuilt every month. This is that spreadsheet, computed
 * from the rows.
 *
 * THREE LINES, NOT ONE, and the middle one is the reason the record is worth
 * having:
 *
 *   revenue - directCost      = grossProfit    what the trips earned
 *   grossProfit - overhead    = netProfit      what the company kept
 *
 * A single "profit" figure hides which of the two moved. A month where the
 * trips earned well and the net still fell is an overhead problem; one where
 * both fell is a freight problem. They are different conversations and the
 * report should not need a second request to tell them apart.
 *
 * THIS IS THE ONE PLACE OVERHEAD IS A COST OF ANYTHING. `grossProfitSchema`
 * names an operation expense among its deliberate absences and that stands
 * unchanged — nothing here apportions the office lease across trips, because
 * apportioning it by revenue, by distance or by count would invent a number.
 * It is subtracted ONCE, at the bottom, from a period rather than from a trip,
 * which is the only level at which it is a real figure.
 *
 * WHICH TRIPS COUNT, AND ON WHAT DATE
 *
 * A trip belongs to the period its `shipmentDate` falls in — "the date the trip
 * ran, as it appears on the paperwork". The three plausible alternatives are
 * all worse:
 *
 *   `closedAt`      moves a trip's revenue to whenever the paperwork was
 *                   finished, so a slow liquidation books August's freight into
 *                   October and both months are wrong. It also means a period
 *                   is never final in the other direction: every open trip is
 *                   revenue with no month yet.
 *   `dispatchedAt`  is an event the system stamps when somebody presses a
 *                   button, so a booking typed up a week late reports the wrong
 *                   month for a reason that has nothing to do with the trip.
 *   `createdAt`     is when the row was typed, which is not a fact about the
 *                   business at all.
 *
 * `shipmentDate` is the one column that states when the trip RAN, which is when
 * its revenue is recognised — the same rule that keeps a `ClientPayment` out of
 * revenue. It is correctable up to LIQUIDATED, deliberately, so a trip filed
 * under the wrong date can be moved to the month it belongs to.
 *
 * DRAFTS ARE EXCLUDED, and nothing else is. A draft has not been dispatched:
 * nothing left the yard, no crew is on the road against its figures, and its
 * rate chain is still an editable proposal. Counting one would book revenue for
 * freight that has not moved, and a duplicate booking somebody has not noticed
 * yet would inflate the month. Every status from DISPATCHED on is counted,
 * including trips still in transit — a period read mid-month is meant to show
 * the trips running in it, and `isProvisional` is how the report says the
 * figure will still move.
 *
 * THE WINDOW IS HALF-OPEN — `from` counts, `to` does not — which is the same
 * interval `OperationExpenseSummary` uses, and it has to be: the two halves of
 * this report are filtered on different columns of different tables, and a
 * period that tiled on one and overlapped on the other would double-count
 * overhead at every month boundary while the freight above it did not.
 *
 * NOTHING HERE IS STORED. The same decision as `GrossProfit` and for the same
 * reason, only more so: a stored period total would be a copy of a fact that
 * eight tables determine, and a late port fee on an August trip must change
 * August's profit rather than sit next to it. There is no period close in this
 * system to freeze it against — when one exists, this is the report that wants
 * it, and `OperationExpense` is the table that wants it first.
 */

/**
 * The period, and nothing else.
 *
 * NO CLIENT, NO TRUCK, NO ROUTE, deliberately. Every one of those would be a
 * useful cut and every one of them is a different report: overhead cannot be
 * filtered by client, so a `clientId` here would silently produce a "net
 * profit" that subtracted the whole company's rent from one client's trips.
 * A cut like that needs the overhead line to mean something different, which is
 * a decision to take when somebody asks for it rather than a parameter to leave
 * lying around.
 *
 * BOTH BOUNDS OPTIONAL, matching `operationExpenseSummaryQuerySchema`. Omitting
 * both is "everything on the books", which is a real question at year end and
 * the honest default for a screen that has not been given a period yet.
 */
export const profitAndLossQuerySchema = z.object({
  /** Inclusive lower bound on `shipment.shipmentDate` and `operationExpense.spentAt`. */
  from: isoDateTimeSchema.optional(),
  /** EXCLUSIVE upper bound on both. See the note above. */
  to: isoDateTimeSchema.optional(),
});

export type ProfitAndLossQuery = z.infer<typeof profitAndLossQuerySchema>;

/**
 * One trip's contribution to the period.
 *
 * THE BREAKDOWN TRAVELS WITH THE TOTAL, the same call `GrossProfit`,
 * `ClientPaymentSummary` and `OperationExpenseSummary` all make. A month's
 * profit is a number nobody can act on until they can see which trips made it,
 * and the first question anybody asks of a bad month is "which ones" — an
 * answer that should not need a second request against a filter the caller has
 * to reconstruct.
 *
 * THE FIGURES ARE THE TRIP'S OWN, computed by the same arithmetic the trip
 * screen shows, so a row here and the card on `/shipments/:id` cannot disagree.
 * Their revenue and cost sum to the period's, exactly — which is what makes the
 * total auditable rather than merely plausible.
 *
 * ABBREVIATED ON PURPOSE. This is the shape of a table row, not a second copy
 * of `GrossProfit`: the full decomposition of one trip is a request away, and
 * repeating fourteen figures per shipment would make a year's report a payload
 * nobody renders.
 */
export const profitAndLossShipmentSchema = z.object({
  shipmentId: z.string(),
  shipmentNumber: z.string(),
  /** The date the trip RAN, which is what put it in this period. */
  shipmentDate: z.string(),
  clientName: z.string().nullable(),
  revenue: z.string(),
  cost: z.string(),
  grossProfit: z.string(),
  /** This trip's figure will still move. Contributes to the period's own flag. */
  isProvisional: z.boolean(),
});

export type ProfitAndLossShipment = z.infer<typeof profitAndLossShipmentSchema>;

/**
 * The period's profit and loss.
 *
 * THE WINDOW IS ECHOED BACK because both bounds are optional — a total with no
 * stated period means something different depending on what the caller happened
 * to send, and a screenshot of one is unreadable a week later. Same reason
 * `OperationExpenseSummary` does it.
 *
 * EVERY FIGURE IS A DECIMAL STRING at 2dp, never a JSON number, and the web app
 * does no arithmetic on any of them. The two margins are the exception that
 * proves it: they are rates rather than money, they are presentational, and
 * they are computed here so there is one definition of a margin rather than one
 * per screen.
 */
export const profitAndLossSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),

  // --- revenue, from the trips that ran in the window ----------------------
  /** The freight before the broker's cut, shown so the cut is a visible line. */
  grossRate: z.string(),
  thirdPartyCommission: z.string(),
  netRate: z.string(),
  billableExpenses: z.string(),
  additionalCharges: z.string(),
  revenue: z.string(),

  // --- what those trips cost -----------------------------------------------
  liquidatedExpenses: z.string(),
  companyPaidExpenses: z.string(),
  companyPaidBillableExpenses: z.string(),
  crewCommissions: z.string(),
  /**
   * The four above. Named `directCost` rather than `cost` precisely because
   * there is a second cost below it — a field called `cost` sitting above an
   * overhead line is one somebody eventually reads as the total.
   */
  directCost: z.string(),

  /** `revenue - directCost`. What the trips earned, before the office. */
  grossProfit: z.string(),
  /** Gross profit over revenue. Null on zero revenue, never a zero that reads like a margin. */
  grossMargin: z.string().nullable(),

  // --- what the company spent on itself ------------------------------------
  /**
   * Overhead over the same window, by `spentAt`. The ONE place in the system
   * where an operation expense is subtracted from anything.
   */
  operatingExpenses: z.string(),
  /** Which overhead, largest first. The same rows `OperationExpenseSummary` totals. */
  operatingExpensesByCategory: z.array(operationExpenseCategoryTotalSchema),

  /** `grossProfit - operatingExpenses`. What the company kept. */
  netProfit: z.string(),
  /** Net profit over revenue. Null on zero revenue, for the reason above. */
  netMargin: z.string().nullable(),

  // --- what the number is standing on --------------------------------------
  shipmentCount: z.number().int().nonnegative(),
  /** How many of them are still moving. Zero is what makes a period readable as final. */
  provisionalShipmentCount: z.number().int().nonnegative(),
  operationExpenseCount: z.number().int().nonnegative(),
  /**
   * Any trip in the period is provisional, so the bottom line will still move.
   *
   * ONE UNFINISHED TRIP MAKES THE WHOLE PERIOD PROVISIONAL, which is strict on
   * purpose: a month is quoted as a single number, and a number that is
   * "mostly final" is one somebody quotes as final. `provisionalShipmentCount`
   * is there so the caveat can say how far off it is.
   */
  isProvisional: z.boolean(),

  /** Every trip in the window, largest contribution first. */
  byShipment: z.array(profitAndLossShipmentSchema),
});

export type ProfitAndLoss = z.infer<typeof profitAndLossSchema>;
