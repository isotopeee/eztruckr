import { z } from 'zod';
import { roleRequiresStaffLink, userRoleSchema, type UserRole } from '../codes/user-role';
import { auditFieldsSchema, optionalText, passwordSchema, requiredText } from './common';
import { staffInvitationSchema } from './invitation';

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
  staffId: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  /**
   * The most recent invitation, or null for a login that predates the invite
   * flow. Carried on the user because "has this person actually taken up their
   * account" is part of what an administrator is looking at when they read the
   * list — fetching it separately would be one request per row.
   */
  invitation: staffInvitationSchema.nullable(),
});

export type User = z.infer<typeof userSchema>;

const userFields = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: requiredText(120),
  role: userRoleSchema,
  /**
   * Which `staff` row this login belongs to.
   *
   * Required for the roles in `ROLES_LINKED_TO_STAFF` and forbidden for every
   * other, but for two different reasons. A CREW login that resolved to nobody
   * would see an empty portal, because the link IS its scope key. A
   * DISPATCH_MANAGER is not scoped by it at all — they see every trip — and is
   * linked so the system can tell which of the floats out there are theirs. An
   * office login that resolved to a person would be silently narrowed to that
   * person's records by any query that filtered on it.
   */
  staffId: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

export function hasStaffLinkMatchingRole(value: {
  role: UserRole;
  staffId: string | null;
}): boolean {
  return roleRequiresStaffLink(value.role) ? value.staffId !== null : value.staffId === null;
}

export const STAFF_LINK_MESSAGE =
  'a crew or dispatch-manager login must name the staff member it belongs to, and no other role may';

/**
 * NO PASSWORD FIELD. A login is provisioned empty and its owner sets the
 * password by following an emailed invite, so there is no moment at which an
 * administrator knows a credential that still works. Removing the field is
 * what makes that true — an optional password would be a supported way back to
 * the old flow, and the one caller that forgot to leave it out would be
 * creating accounts nobody ever had to accept.
 *
 * `POST /users` therefore also sends mail. See `InvitationsService`.
 */
export const createUserSchema = userFields.refine(hasStaffLinkMatchingRole, {
  message: STAFF_LINK_MESSAGE,
  path: ['staffId'],
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
