import { z } from 'zod';
import { crewRoleSchema, CrewRole } from '../codes/crew-role';
import {
  auditFieldsSchema,
  isoDateTimeSchema,
  naturalCodeSchema,
  optionalText,
  requiredText,
} from './common';

export const crewMemberSchema = auditFieldsSchema.extend({
  id: z.string(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  dateHired: z.string().nullable(),
  isActive: z.boolean(),
  eligibleRoles: z.array(crewRoleSchema),
  licenseNumber: z.string().nullable(),
  licenseExpiry: z.string().nullable(),
});

export type CrewMember = z.infer<typeof crewMemberSchema>;

/**
 * The writable fields, before the cross-field rule is applied.
 *
 * Kept separate because Zod refuses `.partial()` on an object carrying
 * refinements, and the update schema genuinely needs to drop the rule — see
 * the note on `updateCrewMemberSchema`.
 */
const crewMemberFields = z.object({
  employeeCode: naturalCodeSchema,
  firstName: requiredText(80),
  lastName: requiredText(80),
  phone: optionalText(40),
  address: optionalText(300),
  dateHired: isoDateTimeSchema.nullish().transform((value) => value ?? null),
  // Deduplicated so a caller sending [DRIVER, DRIVER] cannot make the array
  // CHECK constraint or the UI's role chips disagree with themselves.
  eligibleRoles: z
    .array(crewRoleSchema)
    .min(1, 'a crew member must be eligible for at least one role')
    .transform((roles) => [...new Set(roles)].sort((a, b) => a - b)),
  licenseNumber: optionalText(40),
  licenseExpiry: isoDateTimeSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

/** True when the record as a whole is internally consistent. */
export function hasLicenceIfDriver(value: {
  eligibleRoles: readonly number[];
  licenseNumber: string | null;
}): boolean {
  return !value.eligibleRoles.includes(CrewRole.DRIVER) || !!value.licenseNumber;
}

export const LICENCE_REQUIRED_MESSAGE = 'a licence number is required for anyone eligible to drive';

export const createCrewMemberSchema = crewMemberFields.refine(hasLicenceIfDriver, {
  message: LICENCE_REQUIRED_MESSAGE,
  path: ['licenseNumber'],
});

export type CreateCrewMemberInput = z.infer<typeof createCrewMemberSchema>;

/**
 * Partial update.
 *
 * The driver/licence rule is deliberately absent here: a request that sends
 * only `licenseNumber` has no `eligibleRoles` to compare it against, so the
 * check is meaningless at this layer. The service re-applies
 * `hasLicenceIfDriver` to the patch merged onto the stored row — the only
 * place the whole record is actually known.
 */
export const updateCrewMemberSchema = crewMemberFields.partial();

export type UpdateCrewMemberInput = z.infer<typeof updateCrewMemberSchema>;
