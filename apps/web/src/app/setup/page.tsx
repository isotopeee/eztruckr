'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/api-client';
import { SYSTEM_STATUS_KEY, useSystemStatus } from '@/lib/use-system-status';

/**
 * First-run setup: name the first administrator and send them their invite.
 *
 * OUTSIDE THE `(app)` GROUP, like `/login` and `/accept-invite`, because the
 * whole point is that no session can exist yet.
 *
 * NO PASSWORD IS SET HERE. The administrator receives the same invite link
 * every other account gets and chooses their own — so whoever runs setup does
 * not end up knowing the credential, and setting up on someone's behalf is a
 * normal thing to do rather than a handover of a password.
 */
export default function SetupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { initialized, isPending, isError } = useSystemStatus();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const initialize = useMutation({
    mutationFn: () =>
      apiFetch<void>('/system/initialize', {
        method: 'POST',
        body: JSON.stringify({ email, name }),
      }),
    onSuccess: async () => {
      setDone(true);
      // The answer this page keys off has just changed, and it is cached
      // forever by design.
      await queryClient.invalidateQueries({ queryKey: SYSTEM_STATUS_KEY });
    },
    onError: (mutationError) => {
      setError(
        mutationError instanceof ApiError
          ? mutationError.displayMessage
          : 'Something went wrong. Try again.',
      );
    },
  });

  if (isPending) {
    return (
      <Shell>
        <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Checking this system…
        </CardContent>
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell description="Could not reach the API.">
        <CardContent className="text-muted-foreground text-sm">
          Setup cannot start until the API is reachable. Check that it is running, then reload.
        </CardContent>
      </Shell>
    );
  }

  // Already set up, and arriving here directly. Not an error — a bookmark, or a
  // second person opening the link — so it reads as information, not a failure.
  if (initialized && !done) {
    return (
      <Shell description="This system has already been set up.">
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Sign in, or ask an administrator to invite you.
          </p>
          <Button className="w-full" onClick={() => router.replace('/login')}>
            Go to sign in
          </Button>
        </CardContent>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title="Setup complete" description={`An invite is on its way to ${email}.`}>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <p className="text-muted-foreground text-sm">
              Follow the link in that email to choose a password. Until then the account cannot sign
              in — and this setup page is closed for good.
            </p>
          </div>
          <Button variant="outline" className="w-full" onClick={() => router.replace('/login')}>
            Go to sign in
          </Button>
        </CardContent>
      </Shell>
    );
  }

  const submittable = email.trim().length > 0 && name.trim().length > 0 && !initialize.isPending;

  return (
    <Shell
      title="Set up EZTruckr"
      description="Name the first administrator. They will be emailed an invite to choose their password."
    >
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            initialize.mutate();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="name">Administrator name</Label>
            <Input
              id="name"
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Grace Mendoza"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Administrator email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@eztruckr.ph"
              aria-describedby="email-help"
            />
            <p id="email-help" className="text-muted-foreground text-xs">
              The invite goes here. Make sure you can read this mailbox — it is the only way into
              the account.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={!submittable}>
            {initialize.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Create administrator and send invite
          </Button>

          <p className="text-muted-foreground text-xs">
            This can only be done once. Afterwards, accounts are created by an administrator.
          </p>
        </form>
      </CardContent>
    </Shell>
  );
}

function Shell({
  children,
  title = 'EZTruckr',
  description = 'First-run setup.',
}: {
  children: React.ReactNode;
  title?: string;
  description?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <div className="flex items-center gap-2">
            <Truck className="size-5" />
            <CardTitle>{title}</CardTitle>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children}
      </Card>
    </main>
  );
}
