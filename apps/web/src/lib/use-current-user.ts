'use client';

import { useQuery } from '@tanstack/react-query';
import type { SessionUser } from '@eztruckr/types';
import { apiFetch, ApiError } from '@/lib/api-client';

export const CURRENT_USER_KEY = ['me'] as const;

/**
 * The signed-in user, from the API rather than from anything held locally.
 *
 * Navigation and every write button key off this, so a role change or a
 * deactivation takes effect on the next request instead of the next login.
 * A 401 or 403 resolves to `null` rather than throwing: "not signed in" is an
 * ordinary state for this hook, and the app shell redirects on it.
 */
export function useCurrentUser() {
  const query = useQuery({
    queryKey: CURRENT_USER_KEY,
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        return await apiFetch<SessionUser>('/me');
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  return {
    user: query.data ?? null,
    isPending: query.isPending,
    isError: query.isError,
  };
}
