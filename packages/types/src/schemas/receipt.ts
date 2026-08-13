import { z } from 'zod';
import { auditFieldsSchema } from './common';

/**
 * An uploaded file, as the API describes it back.
 *
 * `storageKey` is deliberately absent. It is the object's address inside the
 * bucket, and nothing outside the API has any use for it — the bytes come back
 * through `GET /receipts/:id/content`, which re-checks who is asking. Handing
 * the key to a browser would only invite somebody to build a URL out of it.
 */
export const receiptSchema = auditFieldsSchema.extend({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAt: z.string(),
});

export type Receipt = z.infer<typeof receiptSchema>;

/**
 * What may be uploaded.
 *
 * Images and PDFs only, because that is what a receipt, a deposit slip or a
 * wallet screenshot is. The list is an allow-list rather than a deny-list: the
 * bytes are served back to a browser later, and anything that a browser might
 * execute rather than display has no business in this bucket.
 */
export const ALLOWED_RECEIPT_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

/** 10 MB. A phone photo of a fuel receipt is comfortably inside this. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function isAllowedReceiptMimeType(mimeType: string): boolean {
  return ALLOWED_RECEIPT_MIME_TYPES.includes(mimeType.toLowerCase());
}

/**
 * How long an unattached receipt is left alone before the sweep may remove it.
 *
 * Upload and attach are separate requests, so between choosing a file and
 * saving the line there is legitimately a receipt belonging to nothing. A day
 * covers a form left open over lunch, a phone that lost signal, and somebody
 * coming back to it tomorrow.
 */
export const ORPHAN_RECEIPT_GRACE_HOURS = 24;

export const sweepOrphanReceiptsQuerySchema = z.object({
  /** Raised for a one-off purge, lowered only for testing. */
  olderThanHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .default(ORPHAN_RECEIPT_GRACE_HOURS),
});

export type SweepOrphanReceiptsQuery = z.infer<typeof sweepOrphanReceiptsQuerySchema>;

/**
 * What the sweep did.
 *
 * `failed` is reported rather than thrown: one unreachable object should not
 * abandon the rest of the run, and the receipt stays on the books to be
 * retried next time.
 */
export const orphanSweepResultSchema = z.object({
  examined: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Left alone because something still references them, deleted rows included. */
  stillAttached: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  bytesReclaimed: z.number().int().nonnegative(),
});

export type OrphanSweepResult = z.infer<typeof orphanSweepResultSchema>;
