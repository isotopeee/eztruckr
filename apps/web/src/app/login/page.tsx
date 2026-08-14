'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn } from '@/lib/auth-client';
import { useSystemStatus } from '@/lib/use-system-status';

/**
 * Sign in.
 *
 * There is deliberately no "create an account" link: accounts are provisioned
 * by an administrator, and the API refuses public sign-up outright. Offering
 * the link and then rejecting the request would be worse than not offering it.
 *
 * THE ONE EXCEPTION IS AN UNSET-UP SYSTEM, which has no accounts at all — this
 * page is where every unauthenticated path already lands, so it is also where
 * the redirect to `/setup` belongs. Doing it here rather than in the app shell
 * keeps it in one place: the shell sends you here, and here decides whether
 * "sign in" is even a meaningful thing to offer yet.
 */
export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { initialized, isPending: statusPending } = useSystemStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Strictly `=== false`: the hook returns undefined while loading and when the
  // API is unreachable, and neither of those means "not set up". Sending
  // somebody to setup because a request failed would offer to create a second
  // first-administrator on a system that already has one.
  useEffect(() => {
    if (initialized === false) {
      router.replace('/setup');
    }
  }, [initialized, router]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);

    const { error: signInError } = await signIn.email({ email, password });

    if (signInError) {
      // Better Auth does not distinguish "no such user" from "wrong password",
      // and neither should the message: telling an attacker which addresses
      // exist is a free gift.
      setError(signInError.message ?? 'Could not sign in. Check your email and password.');
      setPending(false);
      return;
    }

    // /me was cached as null on the way in; without this the shell would
    // bounce straight back to the login screen.
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    router.replace('/');
  };

  // Hold the form back until we know whether signing in is possible at all,
  // so an unset-up system never flashes a login screen on its way to /setup.
  if (statusPending || initialized === false) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <div className="flex items-center gap-2">
            <Truck className="size-5" />
            <CardTitle>EZTruckr</CardTitle>
          </div>
          <CardDescription>Sign in to manage hauling operations.</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@eztruckr.ph"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Sign in
            </Button>
          </form>

          <p className="text-muted-foreground mt-4 text-xs">
            Accounts are created by an administrator.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
