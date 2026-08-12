import { z } from 'zod';
import { userRoleSchema } from '../codes/user-role';

/**
 * What `/api/me` returns: who the caller is, as the app needs to know them.
 *
 * The web app drives navigation off this rather than off anything it stores
 * locally, so a role change or a deactivation takes effect on the next request
 * instead of the next login.
 */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  isActive: z.boolean(),
  crewMemberId: z.string().nullable(),
  displayName: z.string().nullable(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
