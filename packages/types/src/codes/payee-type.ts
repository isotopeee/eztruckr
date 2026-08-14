import { defineCodeSet } from './code-set';

/**
 * What kind of legal person a payee is. Stored as `payee.payeeType` SMALLINT.
 *
 * Recorded rather than inferred, because the two are not distinguishable from
 * the name — "R. Santos Vulcanizing" is a sole proprietor and "Santos Bros"
 * is a partnership, and no amount of string inspection tells them apart. A
 * voucher made out to an individual and one made out to a company are
 * different documents in Philippine practice, so which one this is has to be a
 * fact somebody stated.
 *
 * PAYEES ARE EXTERNAL ONLY. A release of cash to a member of staff is an
 * `Allowance`, whose recipient is a `Staff` foreign key — the two are not
 * merged, and there is deliberately no STAFF code here. An advance to your own
 * driver is answerable for and liquidated; a payment to a vendor is neither.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const PayeeType = {
  COMPANY: 1,
  INDIVIDUAL: 2,
} as const;

export type PayeeType = (typeof PayeeType)[keyof typeof PayeeType];

const meta = defineCodeSet('PayeeType', PayeeType);

export const PAYEE_TYPE_CODES = meta.codes;
export const isPayeeType = meta.isValid;
export const payeeTypeSchema = meta.schema;

export const PAYEE_TYPE_LABELS: Readonly<Record<PayeeType, string>> = {
  [PayeeType.COMPANY]: 'Company',
  [PayeeType.INDIVIDUAL]: 'Individual',
};

/**
 * Whether a separate contact person is worth prompting for.
 *
 * A prompt, never a requirement — the same rule `expectsReferenceNumber`
 * follows. An individual payee is their own contact, so asking for one invites
 * the name to be typed twice and then to disagree with itself after an edit.
 */
export function expectsContactName(payeeType: PayeeType): boolean {
  return payeeType === PayeeType.COMPANY;
}
