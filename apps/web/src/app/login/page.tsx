'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn } from '@/lib/auth-client';

/**
 * Sign in.
 *
 * There is deliberately no "create an account" link: accounts are provisioned
 * by an administrator, and the API refuses public sign-up outright. Offering
 * the link and then rejecting the request would be worse than not offering it.
 */
export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
