'use client';

import { useQuery } from '@tanstack/react-query';
import type { SystemStatus } from '@eztruckr/types';
import { apiFetch } from '@/lib/api-client';

export const SYSTEM_STATUS_KEY = ['system-status'] as const;

/**
 * Has this installation been set up yet?
 *
 * Asked by the sign-in page, so an empty database sends people to `/setup`
 * instead of to a form no account can pass. Public, so it needs no session —
 * which is the point, since nobody can have one before setup runs.
 *
 * `staleTime: Infinity` because this answer changes exactly once in the life of
 * an installation, and re-asking on every focus would put a request behind
 * every tab switch for a value that is false only until it is true. The setup
 * page invalidates the key itself after initialising.
 */
export function useSystemStatus() {
  const query = useQuery({
    queryKey: SYSTEM_STATUS_KEY,
    queryFn: () => apiFetch<SystemStatus>('/system/status'),
    staleTime: Infinity,
    retry: false,
  });

  return {
    // Undefined while loading or if the API is unreachable. Callers must treat
    // "do not know" as distinct from "not initialised" — redirecting to /setup
    // because the API was briefly down would be its own kind of wrong.
    initialized: query.data?.initialized,
    isPending: query.isPending,
    isError: query.isError,
  };
}
