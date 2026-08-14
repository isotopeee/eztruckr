'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type InvitationPreview } from '@eztruckr/types';
import { CheckCircle2, Loader2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/api-client';
import { signIn } from '@/lib/auth-client';

/**
 * Take up an invited account by choosing a password.
 *
 * OUTSIDE THE `(app)` GROUP, like `/login`, because that layout requires a
 * session and the whole point of this page is that the visitor cannot have one
 * yet — their account has no usable password until this form is submitted.
 *
 * The token is validated BEFORE the form is shown, so an expired or withdrawn
 * link says so immediately rather than after somebody has chosen a password and
 * typed it twice.
 */
export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<Shell>{null}</Shell>}>
      <AcceptInvite />
    </Suspense>
  );
}

function AcceptInvite() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = useSearchParams().get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => apiFetch<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
    enabled: token.length > 0,
    // A dead link does not become live by asking again, and each retry is
    // another second the visitor spends looking at a spinner.
    retry: false,
  });

  const accept = useMutation({
    mutationFn: async () => {
      await apiFetch<void>('/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });

      // Sign them straight in. The alternative — bouncing to /login — asks
      // somebody to type a password they set four seconds ago, and the gate
      // that was refusing them has just opened.
      return signIn.email({ email: invitation.data!.email, password });
    },
    onSuccess: async (result) => {
      if (result?.error) {
        // The password IS set at this point; only the convenience sign-in
        // failed. Saying so beats implying the whole thing did not work.
        setError('Your password was set, but signing in failed. Try signing in below.');
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.replace('/');
    },
    onError: (mutationError) => {
      setError(
        mutationError instanceof ApiError
          ? mutationError.displayMessage
          : 'Something went wrong. Try again.',
      );
    },
  });

  if (!token) {
    return (
      <Shell>
        <Problem
          title="No invite token"
          detail="This page needs the link from your invitation email."
        />
      </Shell>
    );
  }

  if (invitation.isPending) {
    return (
      <Shell>
        <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Checking your invitation…
        </CardContent>
      </Shell>
    );
  }

  if (invitation.isError) {
    return (
      <Shell>
        <Problem
          title="This link cannot be used"
          detail={
            invitation.error instanceof ApiError
              ? invitation.error.displayMessage
              : 'The invitation could not be checked. Try again shortly.'
          }
        />
      </Shell>
    );
  }

  const preview = invitation.data;
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirmation.length > 0 && password !== confirmation;
  const submittable =
    password.length >= PASSWORD_MIN_LENGTH && password === confirmation && !accept.isPending;

  return (
    <Shell
      description={
        <>
          Setting the password for <strong>{preview.email}</strong>. If that is not you, close this
          page — the account cannot be used until a password is set.
        </>
      }
      title={`Welcome, ${preview.name}`}
    >
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            accept.mutate();
          }}
          className="space-y-4"
        >
          {/* Hidden but present: password managers key their entry on the
              username, and without it they offer to save a nameless secret. */}
          <input type="hidden" autoComplete="username" value={preview.email} readOnly />

          <div className="space-y-2">
            <Label htmlFor="password">Choose a password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby="password-help"
            />
            <p
              id="password-help"
              className={tooShort ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
            >
              At least {PASSWORD_MIN_LENGTH} characters.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmation">Confirm password</Label>
            <Input
              id="confirmation"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {mismatch ? <p className="text-destructive text-xs">These do not match.</p> : null}
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={!submittable}>
            {accept.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Set password and sign in
          </Button>
        </form>
      </CardContent>
    </Shell>
  );
}

function Shell({
  children,
  title = 'EZTruckr',
  description = 'Activate your account.',
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

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <CardContent className="space-y-4">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{detail}</p>
        </div>
      </div>
      <Button asChild variant="outline" className="w-full">
        <a href="/login">Go to sign in</a>
      </Button>
    </CardContent>
  );
}
