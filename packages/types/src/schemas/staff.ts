import { z } from 'zod';
import { staffRoleSchema, StaffRole } from '../codes/staff-role';
import { auditFieldsSchema, isoDateTimeSchema, optionalText, requiredText } from './common';

/**
 * Everyone who works here — drivers, helpers, and the office staff who handle
 * their money.
 *
 * ONE TABLE, and it was `crew_member` until a dispatch manager needed to be the
 * custodian of a trip's cash. The alternative was a custodian column pointing
 * at either a crew member or a user, which is one column doing two jobs held
 * together by a convention — the defect this codebase keeps finding. Unifying
 * the people instead leaves every foreign key pointing at exactly one place.
 *
 * `eligibleRoles` says what this person MAY be engaged as; the role actually
 * filled on a trip comes from the shipment slot and is recorded on Commission.
 */
export const staffSchema = auditFieldsSchema.extend({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  dateHired: z.string().nullable(),
  isActive: z.boolean(),
  eligibleRoles: z.array(staffRoleSchema),
  licenseNumber: z.string().nullable(),
  licenseExpiry: z.string().nullable(),
});

export type Staff = z.infer<typeof staffSchema>;

/**
 * The writable fields, before the cross-field rule is applied.
 *
 * Kept separate because Zod refuses `.partial()` on an object carrying
 * refinements, and the update schema genuinely needs to drop the rule — see
 * the note on `updateStaffSchema`.
 */
const staffFields = z.object({
  firstName: requiredText(80),
  lastName: requiredText(80),
  phone: optionalText(40),
  /**
   * Contact address, not a login. Nullish before the email check, so "clear
   * this field" stays expressible — the same shape `Client` and `Payee` use.
   */
  email: z
    .string()
    .trim()
    .email()
    .nullish()
    .transform((value) => value ?? null),
  address: optionalText(300),
  dateHired: isoDateTimeSchema.nullish().transform((value) => value ?? null),
  // Deduplicated so a caller sending [DRIVER, DRIVER] cannot make the array
  // CHECK constraint or the UI's role chips disagree with themselves.
  eligibleRoles: z
    .array(staffRoleSchema)
    .min(1, 'a staff member must be eligible for at least one role')
    .transform((roles) => [...new Set(roles)].sort((a, b) => a - b)),
  licenseNumber: optionalText(40),
  licenseExpiry: isoDateTimeSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

/** The licence halves, both required of anyone eligible to drive. */
export const LICENCE_FIELDS = ['licenseNumber', 'licenseExpiry'] as const;

export type LicenceField = (typeof LICENCE_FIELDS)[number];

export const LICENCE_REQUIRED_MESSAGES: Record<LicenceField, string> = {
  licenseNumber: 'a licence number is required for anyone eligible to drive',
  licenseExpiry: 'a licence expiry date is required for anyone eligible to drive',
};

/**
 * Which half of the licence a driver-eligible record is missing, or null when
 * it is complete.
 *
 * BOTH HALVES, not just the number. A record with a number and no expiry looks
 * filled in on the staff screen and is then refused at the moment somebody is
 * put in a driver slot — which is a worse place to find out, because by then a
 * trip is being dispatched and the fix is on another screen. Requiring the pair
 * here moves the complaint to where the data is entered.
 *
 * RETURNS THE FIELD rather than a boolean, so the error can name the one that
 * is actually missing. Pointing at `licenseNumber` when the expiry is blank
 * sends somebody to look at a value that is already correct.
 *
 * Tests `includes(DRIVER)` rather than "is not office staff", so a dispatch
 * manager needs no licence and somebody eligible for both still does.
 *
 * DELIBERATELY DOES NOT CHECK THE DATE. An expired licence is a fact worth
 * recording — the office knows it lapsed and wants it on file — and it is the
 * DRIVER SLOT that refuses to dispatch against one, in `assertMayDrive`.
 * Refusing it here would leave nowhere to record the truth.
 */
export function missingLicenceField(value: {
  eligibleRoles: readonly number[];
  licenseNumber: string | null;
  licenseExpiry: string | null;
}): LicenceField | null {
  if (!value.eligibleRoles.includes(StaffRole.DRIVER)) {
    return null;
  }

  if (!value.licenseNumber) return 'licenseNumber';
  if (!value.licenseExpiry) return 'licenseExpiry';

  return null;
}

/** True when the record as a whole is internally consistent. */
export function hasLicenceIfDriver(value: {
  eligibleRoles: readonly number[];
  licenseNumber: string | null;
  licenseExpiry: string | null;
}): boolean {
  return missingLicenceField(value) === null;
}

export const createStaffSchema = staffFields.superRefine((value, ctx) => {
  const missing = missingLicenceField(value);

  // `superRefine` rather than `refine`, so the issue lands on whichever half is
  // absent instead of always on `licenseNumber`.
  if (missing) {
    ctx.addIssue({
      code: 'custom',
      message: LICENCE_REQUIRED_MESSAGES[missing],
      path: [missing],
    });
  }
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;

/**
 * Partial update.
 *
 * The driver/licence rule is deliberately absent here: a request that sends
 * only `licenseNumber` has no `eligibleRoles` to compare it against, so the
 * check is meaningless at this layer. The service re-applies
 * `hasLicenceIfDriver` to the patch merged onto the stored row — the only
 * place the whole record is actually known.
 */
export const updateStaffSchema = staffFields.partial();

export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
