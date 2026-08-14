import { z } from 'zod';
import { requiredText } from './common';

/**
 * Whether this installation has been set up yet.
 *
 * Read by the web app before it shows anything, so an empty database sends
 * people to `/setup` rather than to a login screen no account can pass.
 *
 * DELIBERATELY THE ONLY THING THIS ENDPOINT SAYS. It is public and
 * unauthenticated, so it must not leak how many users exist, who they are, or
 * anything else about a system a stranger has not been let into.
 */
export const systemStatusSchema = z.object({
  initialized: z.boolean(),
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;

/**
 * What setting up an installation takes: a name and an address to send the
 * first administrator's invite to.
 *
 * NO PASSWORD FIELD, for the same reason `createUserSchema` has none — the
 * administrator sets their own from the emailed link, so the person running
 * setup never chooses a credential, and a half-finished setup leaves no
 * account anyone can sign in to.
 */
export const initializeSystemSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: requiredText(120),
});

export type InitializeSystemInput = z.infer<typeof initializeSystemSchema>;
