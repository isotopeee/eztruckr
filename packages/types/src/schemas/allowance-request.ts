import { z } from 'zod';
import {
  AllowanceRequestStatus,
  allowanceRequestStatusSchema,
  isAllowanceRequestStatus,
} from '../codes/allowance-request-status';
import { disbursementModeSchema, expectsProofOfRelease } from '../codes/disbursement-mode';
import { releasedMoneySchema } from './allowance';
import {
  auditFieldsSchema,
  idSchema,
  isoDateTimeSchema,
  optionalText,
  requiredText,
} from './common';

/**
 * Dispatch asking accounting to release cash, and what accounting decided.
 *
 * WHY A RECORD AND NOT A PHONE CALL. A dispatch manager knows a truck leaves at
 * five and the driver needs ₱10,000; accounting holds the money and is the only
 * desk that may release it. Those are two people, and until this existed the
 * conversation between them lived in a chat thread — so a release nobody could
 * account for was indistinguishable from a release nobody had asked for.
 *
 * WHAT IT IS NOT is a second kind of allowance. An approved request produces an
 * ordinary `Allowance`, on the ordinary account, counted in the ordinary
 * `totalAdvanced`. This row is the ASK and the DECISION; the money is where it
 * always was. Anything reading trip cash keeps reading allowances and needs to
 * know nothing about this table.
 */
export const allowanceRequestSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  /** Denormalised for the cross-trip queue, which lists trips it never loads. */
  shipmentNumber: z.string().nullable(),

  /**
   * Which custodian's account the release would land on — whose variance it
   * would move. Named by the requester, because dispatch is who knows whose
   * float this is, and carried through approval unchanged.
   */
  liquidationId: z.string(),
  custodianName: z.string().nullable(),
  /** That account's number on the trip — see the note on `Allowance`. */
  liquidationSequence: z.number().int(),

  /** Who the cash is for. The same independence an `Allowance` has: a helper
   * can be handed ferry money the driver still answers for. */
  staffId: z.string(),
  staffName: z.string().nullable(),

  amount: z.string(),

  /** What the cash is for. Always present — see the create schema. */
  purpose: z.string(),

  status: allowanceRequestStatusSchema,

  requestedBy: z.string(),
  requestedByName: z.string().nullable(),
  requestedAt: z.string(),

  /** Null while PENDING; both set together the moment accounting answers. */
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),

  /** Required on a decline, absent on an approval. */
  decisionReason: z.string().nullable(),

  /**
   * The release this request turned into. Non-null exactly when APPROVED, which
   * the database asserts rather than trusts — an approved request pointing at
   * no release would be a record of cash that was authorised and then never
   * traceable.
   */
  allowanceId: z.string().nullable(),

  /**
   * The ask was changed after it was raised, and is still waiting.
   *
   * REPORTED, NEVER REFUSED — the same call as `referenceNumberIsDuplicated`,
   * and here it closes a hole that editing would otherwise open. Accounting
   * approves a figure they read off a screen; if dispatch may revise a pending
   * request, the figure can move between the reading and the click, and
   * approval carries no amount of its own to check against. Saying so on the
   * row is what lets the approver notice.
   *
   * DERIVED FROM `updatedBy` rather than stored, so it cannot disagree with the
   * row it describes — the same argument as `Shipment.commissionsStale`. Not
   * from the timestamps: `updatedAt` is Prisma's clock and `requestedAt` is
   * Postgres's, and on an untouched row they differ by milliseconds in
   * whichever direction they fall. The audit extension forces `updatedBy` to
   * null on create and stamps it on every update, which makes the question
   * exact.
   *
   * Only meaningful while PENDING: deciding a request is an update too, so it
   * is false for anything decided rather than quietly true for all of them.
   */
  editedAfterRaising: z.boolean().default(false),
});

export type AllowanceRequest = z.infer<typeof allowanceRequestSchema>;

/**
 * Raising one.
 *
 * FOUR FIELDS, AND NO DISBURSEMENT MODE. How the money physically moves — cash
 * in the yard, a transfer, a wallet — is accounting's to choose when they pay,
 * not dispatch's to specify when they ask. Putting it here would mean a request
 * could be approved by a rail the person approving it does not use, and the
 * proof rule below is keyed off the real one.
 */
export const createAllowanceRequestSchema = z.object({
  /** Required, as on a release: every ask is against exactly one account. */
  liquidationId: idSchema,
  staffId: idSchema,
  amount: releasedMoneySchema,

  /**
   * What the cash is for, and REQUIRED — the only mandatory free text anywhere
   * in this API.
   *
   * Everything else of this kind is `remarks`: an optional note on a record of
   * something that already happened, fairly left blank. This is the ask itself.
   * Accounting is being asked to release money to somebody they cannot see, on
   * a trip they are not running, and "₱10,000 for Reyes" with no reason is a
   * decision made on a number alone. `optionalText` would have collapsed a
   * blank to null, so the refusal has to happen here, before it is a row.
   */
  purpose: requiredText(400),
});

export type CreateAllowanceRequestInput = z.infer<typeof createAllowanceRequestSchema>;

/**
 * Correcting an ask nobody has answered yet.
 *
 * PARTIAL, like `updateAllowanceSchema` beside it, so a caller may move the
 * amount without restating the account. `purpose` keeps its `requiredText`
 * refusal when it IS sent — partial makes a field omittable, not blankable, so
 * there is no way to edit an ask down to having no reason in it.
 *
 * WHILE PENDING ONLY, which the service enforces. A decided request is the
 * record of a decision: editing an approved one would rewrite what accounting
 * agreed to and leave the release beside it saying something else, and editing
 * a declined one would erase the ask the reason was written about. That is the
 * same argument that makes `decline` terminal — "₱10,000, declined, too much"
 * followed by "₱6,000, approved" is two facts worth keeping.
 *
 * What it fixes is narrow and entirely real: the wrong recipient, a digit too
 * many, a purpose that reads badly. The only route before was to withdraw and
 * raise it again — the same edit performed clumsily, and one that resets the
 * request's age, which is the order accounting's queue is worked in.
 */
export const updateAllowanceRequestSchema = createAllowanceRequestSchema.partial();

export type UpdateAllowanceRequestInput = z.infer<typeof updateAllowanceRequestSchema>;

/**
 * Approving one: the details of the release accounting is about to record.
 *
 * THE AMOUNT IS NOT HERE, and that is a decision rather than an omission.
 * Approval releases what was asked for. Releasing less is not an approval of a
 * different request, it is a refusal of this one — so it is a decline, with the
 * reason that makes it actionable, and dispatch raises the ask they can live
 * with. The alternative leaves a row saying "approved" beside a figure nobody
 * agreed to.
 */
export const approveAllowanceRequestSchema = z
  .object({
    disbursementMode: disbursementModeSchema,

    /** Optional for every mode, exactly as on a direct release. */
    referenceNumber: optionalText(80),

    /**
     * Proof of release. REQUIRED for a transfer or a wallet payment — see the
     * refinement below, and `expectsProofOfRelease` for why the rule is a rule
     * here and a prompt everywhere else.
     */
    receiptId: idSchema.nullish().transform((value) => value ?? null),

    /** Defaults to now, so a release paid this morning can be recorded at noon. */
    issuedAt: isoDateTimeSchema.nullish().transform((value) => value ?? null),

    /** Defaults to the approver. Names whoever physically handed the cash over. */
    releasedBy: idSchema.nullish().transform((value) => value ?? null),

    /**
     * Goes onto the release. Optional, and unrelated to the request's `purpose`
     * — this annotates the PAYMENT ("paid in two tranches"), where `purpose`
     * says why it was asked for. The release inherits the purpose when this is
     * left blank.
     */
    remarks: optionalText(400),
  })
  .superRefine((value, ctx) => {
    if (expectsProofOfRelease(value.disbursementMode) && value.receiptId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message:
          'Attach the transfer confirmation or wallet screenshot. A release paid this way already produced one, and it is what ties the money to the person who asked for it.',
      });
    }
  });

export type ApproveAllowanceRequestInput = z.infer<typeof approveAllowanceRequestSchema>;

/** Refusing one. The reason is the entire content of the message going back. */
export const declineAllowanceRequestSchema = z.object({
  reason: requiredText(400),
});

export type DeclineAllowanceRequestInput = z.infer<typeof declineAllowanceRequestSchema>;

/**
 * The cross-trip queue.
 *
 * Defaults to PENDING because that is the only status anybody is waiting on;
 * the decided ones are read on the trip they belong to.
 */
export const allowanceRequestListQuerySchema = z.object({
  status: z.coerce
    .number()
    .int()
    .refine(isAllowanceRequestStatus, 'unknown allowance request status')
    .default(AllowanceRequestStatus.PENDING),
});

export type AllowanceRequestListQuery = z.infer<typeof allowanceRequestListQuerySchema>;
