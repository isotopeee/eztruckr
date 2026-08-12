'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth's browser client, pointed at the API's mounted handler.
 *
 * The API serves auth under `/api/auth`, and NEXT_PUBLIC_API_URL already ends
 * in `/api`, so the base URL is derived rather than configured twice — a
 * mismatch between the two would show up only as a login that silently posts
 * to the wrong origin.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export const authClient = createAuthClient({
  baseURL: `${API_BASE_URL}/auth`,
  fetchOptions: {
    // The session cookie is set by the API on a different origin in
    // development, so it has to be sent explicitly.
    credentials: 'include',
  },
});

export const { signIn, signOut, useSession } = authClient;
