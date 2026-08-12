import { z } from 'zod';
import { UserRole, userRoleSchema } from '../codes/user-role';
import { auditFieldsSchema, optionalText, requiredText } from './common';

/**
 * A login as returned by the API.
 *
 * Never carries a password hash: that lives on the Better Auth `account` row
 * and has no reason to leave the server.
 */
export const userSchema = auditFieldsSchema.extend({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  isActive: z.boolean(),
  emailVerified: z.boolean(),
  crewMemberId: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});

export type User = z.infer<typeof userSchema>;

/** Matches Better Auth's configured `minPasswordLength`. */
export const PASSWORD_MIN_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128);

const userFields = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: requiredText(120),
  role: userRoleSchema,
  /**
   * Required for CREW and forbidden otherwise. A crew login that resolves to
   * no crew member would see an empty portal; an office login that resolves to
   * one would be silently scoped to a single person's records.
   */
  crewMemberId: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

export function hasCrewLinkMatchingRole(value: {
  role: UserRole;
  crewMemberId: string | null;
}): boolean {
  return value.role === UserRole.CREW ? value.crewMemberId !== null : value.crewMemberId === null;
}

export const CREW_LINK_MESSAGE =
  'a crew login must be linked to a crew member, and only a crew login may be';

export const createUserSchema = userFields
  .extend({ password: passwordSchema })
  .refine(hasCrewLinkMatchingRole, {
    message: CREW_LINK_MESSAGE,
    path: ['crewMemberId'],
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Password changes go through their own endpoint, never a general update. */
export const updateUserSchema = userFields.partial();

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setPasswordSchema = z.object({
  password: passwordSchema,
});

export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

/** Contact and presentation detail, kept off the security-critical user row. */
export const userProfileSchema = auditFieldsSchema.extend({
  id: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  phone: z.string().nullable(),
  avatarKey: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  isActive: z.boolean(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export const updateUserProfileSchema = z.object({
  displayName: optionalText(120),
  phone: optionalText(40),
  locale: z.string().trim().min(2).max(20).optional(),
  timezone: z.string().trim().min(3).max(60).optional(),
});

export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
