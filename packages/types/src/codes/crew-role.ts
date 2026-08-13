import { defineCodeSet } from './code-set';
import { StaffRole } from './staff-role';

/**
 * Role a staff member fills on one specific trip. Stored as `commission.role`
 * SMALLINT, and the slots on the shipment are the driver and the helper.
 *
 * The role belongs to the assignment, never to the person: the same person can
 * drive one trip and help on another.
 *
 * A STRICT SUBSET OF `StaffRole`, and derived from it rather than repeating its
 * numbers — the two sets share a numbering, so writing `DRIVER: 1` twice would
 * be two places for it to become 4. What makes this set the smaller one is
 * COMMISSION: everything that multiplies a base by a rate keys on `CrewRole`,
 * and a dispatch manager holds cash without earning any. `commission.role` and
 * `commission_rule.role` both carry `CHECK (role IN (1, 2))`, so that exclusion
 * is the database's, not this comment's.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const CrewRole = {
  DRIVER: StaffRole.DRIVER,
  HELPER: StaffRole.HELPER,
} as const;

export type CrewRole = (typeof CrewRole)[keyof typeof CrewRole];

const meta = defineCodeSet('CrewRole', CrewRole);

export const CREW_ROLE_CODES = meta.codes;
export const isCrewRole = meta.isValid;
export const crewRoleSchema = meta.schema;

export const CREW_ROLE_LABELS: Readonly<Record<CrewRole, string>> = {
  [CrewRole.DRIVER]: 'Driver',
  [CrewRole.HELPER]: 'Helper',
};
