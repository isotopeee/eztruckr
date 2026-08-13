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
