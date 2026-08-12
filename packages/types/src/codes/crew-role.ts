import { defineCodeSet } from './code-set';

/**
 * Role a crew member fills on one specific trip. Stored as
 * `commission.role` SMALLINT and inside `crew_member.eligibleRoles`.
 *
 * The role belongs to the assignment, never to the person: the same crew
 * member can drive one trip and help on another.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const CrewRole = {
  DRIVER: 1,
  HELPER: 2,
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
