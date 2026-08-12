'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ApiError } from '@/lib/api-client';

/**
 * TanStack Query provider.
 *
 * The client is created inside state so each browser session gets its own,
 * and server renders never share cache between requests.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,

            /**
             * Never retry a client error.
             *
             * A 401, 403, 404 or 400 is a settled answer — the server has
             * understood the request and refused it, and asking again changes
             * nothing. Retrying them costs a round trip and, worse, leaves the
             * UI in a loading state while it happens, so a crew member who
             * opens a page they may not see watches a spinner instead of
             * reading why. Server errors and genuine network failures are
             * still worth one more try.
             */
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 1;
            },

            /**
             * Never pause on "offline".
             *
             * The default mode suspends fetches whenever the browser reports
             * no connection, and a paused query renders as pending forever —
             * an unexplained spinner with no error and no way out. That signal
             * is also unreliable here: `navigator.onLine` reports whether a
             * network interface exists, not whether this API is reachable, and
             * the API may be on localhost or the same LAN. Better to attempt
             * the request and show the failure.
             */
            networkMode: 'always',
          },
          mutations: {
            networkMode: 'always',
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
