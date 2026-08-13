import { z } from 'zod';
import { staffRoleSchema, StaffRole } from '../codes/staff-role';
import {
  auditFieldsSchema,
  isoDateTimeSchema,
  naturalCodeSchema,
  optionalText,
  requiredText,
} from './common';

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
  staffCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
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
  staffCode: naturalCodeSchema,
  firstName: requiredText(80),
  lastName: requiredText(80),
  phone: optionalText(40),
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

/**
 * True when the record as a whole is internally consistent.
 *
 * Tests `includes(DRIVER)` rather than "is not office staff", so a dispatch
 * manager needs no licence and somebody eligible for both still does.
 */
export function hasLicenceIfDriver(value: {
  eligibleRoles: readonly number[];
  licenseNumber: string | null;
}): boolean {
  return !value.eligibleRoles.includes(StaffRole.DRIVER) || !!value.licenseNumber;
}

export const LICENCE_REQUIRED_MESSAGE = 'a licence number is required for anyone eligible to drive';

export const createStaffSchema = staffFields.refine(hasLicenceIfDriver, {
  message: LICENCE_REQUIRED_MESSAGE,
  path: ['licenseNumber'],
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
