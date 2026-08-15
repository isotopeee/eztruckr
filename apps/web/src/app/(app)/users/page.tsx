'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INVITATION_STATUS_LABELS,
  InvitationStatus,
  PASSWORD_MIN_LENGTH,
  USER_ROLE_LABELS,
  UserRole,
  invitationStatus,
  type Staff,
  type Page,
  type RemovalResult,
  type StaffInvitation,
  type User,
} from '@eztruckr/types';
import { Ban, KeyRound, Loader2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ResourceForm } from '@/components/master-data/resource-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { FieldSpec, FormValues } from '@/lib/resource-spec';
import { formatDateTime } from '@/lib/format';

/**
 * Logins.
 *
 * Not built on `ResourcePage` because users are not master data: creating one
 * sends an invitation, changing a password takes a separate endpoint, and the
 * crew link is conditional on the role. Forcing it into the generic screen
 * would mean bending the generic screen out of shape for the one case that
 * differs.
 *
 * NO PASSWORD FIELD ON CREATE. The account is provisioned empty and its owner
 * sets the password from an emailed link, so nobody here ever knows a working
 * credential. `Set password` remains as break-glass recovery for someone locked
 * out whose mailbox is also gone — deliberately a separate, deliberate act
 * rather than the way accounts begin.
 */
export default function UsersPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);
  const [revoking, setRevoking] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch<Page<User>>('/users?includeInactive=true&pageSize=100'),
  });

  // Only unlinked crew members can be offered, plus whoever this login is
  // already linked to — one live login per crew member is a database
  // guarantee, and offering a taken one would produce a 409 the user cannot
  // act on.
  const crew = useQuery({
    queryKey: ['staff', 'for-linking'],
    queryFn: () => apiFetch<Page<Staff>>('/staff?pageSize=200'),
  });

  const linkedStaffIds = new Set(
    (users.data?.items ?? [])
      .filter((user) => user.staffId && user.id !== editing?.id)
      .map((user) => user.staffId),
  );

  const fields: FieldSpec[] = [
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: Object.values(UserRole).map((role) => ({
        value: role,
        label: USER_ROLE_LABELS[role],
      })),
    },
    {
      name: 'staffId',
      label: 'Linked staff member',
      type: 'select',
      options: (crew.data?.items ?? [])
        .filter((member) => !linkedStaffIds.has(member.id))
        .map((member) => ({
          value: member.id,
          // Phone disambiguates where a staff code used to. Two people here can
          // genuinely share a name and the database no longer refuses it, so
          // the picker has to offer something to tell them apart.
          label: [`${member.lastName}, ${member.firstName}`, member.phone ?? member.email ?? null]
            .filter(Boolean)
            .join(' — '),
        })),
      help: 'Required for a crew, dispatcher or dispatch-manager login — the three roles that hold a trip’s cash — and forbidden for any other role.',
    },
    { name: 'isActive', label: 'Account active', type: 'boolean' },
  ];

  const formFields = fields.filter((field) => !field.createOnly || !editing);

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setValues({});
    setFieldErrors({});
  };

  const save = useMutation({
    mutationFn: (payload: FormValues) => {
      const body = JSON.stringify({
        ...payload,
        role: payload.role ? Number(payload.role) : undefined,
        staffId: payload.staffId ? payload.staffId : null,
        isActive: payload.isActive === true,
      });

      return editing
        ? apiFetch<User>(`/users/${editing.id}`, { method: 'PATCH', body })
        : apiFetch<User>('/users', { method: 'POST', body });
    },
    onSuccess: async (user) => {
      if (editing) {
        toast.success('Login updated');
      } else if (user.invitation?.deliveryError) {
        // The account exists and the invite is valid; only the send failed.
        // Reporting success here would leave somebody waiting for an email
        // that was never accepted by the transport.
        toast.error(
          `Login created, but the invite email failed: ${user.invitation.deliveryError}`,
          {
            duration: 10000,
          },
        );
      } else {
        toast.success(`Login created. An invite has been emailed to ${user.email}.`);
      }
      closeForm();
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.displayMessage);
        return;
      }
      toast.error('Something went wrong');
    },
  });

  const resendInvite = useMutation({
    mutationFn: (user: User) =>
      apiFetch<StaffInvitation>(`/users/${user.id}/invitation`, { method: 'POST' }),
    onSuccess: async (invitation) => {
      // The API records a failed send rather than throwing, so a 200 here is
      // not the same thing as "the email went out". Saying "sent" when the
      // transport refused is how somebody ends up waiting for a mail that will
      // never arrive.
      if (invitation.deliveryError) {
        toast.error(`Invite created, but sending failed: ${invitation.deliveryError}`, {
          duration: 8000,
        });
      } else {
        toast.success('Invite email sent. The previous link no longer works.');
      }
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.displayMessage : 'Something went wrong');
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (user: User) =>
      apiFetch<StaffInvitation>(`/users/${user.id}/invitation`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRevoking(null);
      toast.success('Invite withdrawn. The link no longer works and the account cannot sign in.');
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.displayMessage : 'Something went wrong');
    },
  });

  const resetPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      apiFetch<void>(`/users/${id}/password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      toast.success('Password set');
      setResetting(null);
      setNewPassword('');
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.displayMessage : 'Something went wrong');
    },
  });

  const remove = useMutation({
    mutationFn: (user: User) => apiFetch<RemovalResult>(`/users/${user.id}`, { method: 'DELETE' }),
    onSuccess: async (result) => {
      toast.success(
        result.outcome === 'DEACTIVATED'
          ? 'Deactivated rather than removed — this login has already acted on records that must keep naming it.'
          : 'Login removed.',
        { duration: result.outcome === 'DEACTIVATED' ? 8000 : 4000 },
      );
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.displayMessage : 'Something went wrong');
      setRemoving(null);
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-muted-foreground text-sm">
            Logins and roles. There is no public sign-up — every account is created here, and its
            owner activates it from an emailed invite.
          </p>
        </div>
        <Button
          onClick={() => {
            setValues({ role: String(UserRole.OPERATIONS), isActive: true });
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          New login
        </Button>
      </header>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Staff link</TableHead>
              <TableHead>Last signed in</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-44 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                  <Loader2 className="mr-2 inline size-4 animate-spin" />
                  Loading…
                </TableCell>
              </TableRow>
            ) : (
              (users.data?.items ?? []).map((user) => (
                <TableRow key={user.id} className={user.isActive ? undefined : 'opacity-60'}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>{USER_ROLE_LABELS[user.role]}</TableCell>
                  <TableCell>
                    {user.staffId ? staffLabel(crew.data?.items ?? [], user.staffId) : '—'}
                  </TableCell>
                  <TableCell>
                    {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}
                  </TableCell>
                  <TableCell>
                    <UserStatus user={user} />
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Resend is offered for anything short of accepted —
                        including expired and revoked, which are the two states
                        an administrator is most likely to be fixing. */}
                    {user.invitation && !user.invitation.acceptedAt ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Resend invite"
                          disabled={resendInvite.isPending}
                          onClick={() => resendInvite.mutate(user)}
                        >
                          <Send className="size-4" />
                        </Button>
                        {/* Asked first, like Remove below: withdrawing shuts an
                            account somebody may be part-way through setting up,
                            and the link they were sent dies with it. */}
                        {!user.invitation.revokedAt ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Withdraw invite"
                            disabled={revokeInvite.isPending}
                            onClick={() => setRevoking(user)}
                          >
                            <Ban className="size-4" />
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Set password"
                      onClick={() => setResetting(user)}
                    >
                      <KeyRound className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit login"
                      onClick={() => {
                        setValues({
                          email: user.email,
                          name: user.name,
                          role: String(user.role),
                          staffId: user.staffId ?? '',
                          isActive: user.isActive,
                        });
                        setEditing(user);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove login"
                      onClick={() => setRemoving(user)}
                    >
                      <Trash2 className="text-destructive size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={creating || editing !== null} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit login' : 'New login'}</DialogTitle>
            <DialogDescription>
              Roles decide what this person can reach. A crew login sees only their own records.
            </DialogDescription>
          </DialogHeader>

          <form
            id="user-form"
            onSubmit={(event) => {
              event.preventDefault();
              setFieldErrors({});
              save.mutate(values);
            }}
          >
            <ResourceForm
              fields={formFields}
              values={values}
              errors={fieldErrors}
              disabled={save.isPending}
              onChange={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
            />
          </form>

          <DialogFooter>
            <Button variant="outline" onClick={closeForm} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="user-form" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResetting(null);
            setNewPassword('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set a password for {resetting?.name}</DialogTitle>
            <DialogDescription>
              At least {PASSWORD_MIN_LENGTH} characters. Existing sessions are unaffected.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResetting(null)}>
              Cancel
            </Button>
            <Button
              disabled={resetPassword.isPending || newPassword.length < PASSWORD_MIN_LENGTH}
              onClick={() =>
                resetting && resetPassword.mutate({ id: resetting.id, password: newPassword })
              }
            >
              {resetPassword.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Set password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw {revoking?.name}&apos;s invite?</DialogTitle>
            <DialogDescription>
              The link they were sent stops working and the account stays shut until somebody sends
              a new invite. Resend mints a fresh link instead, if the old one has simply gone
              astray.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revokeInvite.isPending}
              onClick={() => revoking && revokeInvite.mutate(revoking)}
            >
              {revokeInvite.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Withdraw invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.name}?</DialogTitle>
            <DialogDescription>
              A login that has already created or approved anything is deactivated rather than
              removed, so the audit columns on those records keep resolving to a name.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function staffLabel(members: Staff[], id: string): string {
  const member = members.find((entry) => entry.id === id);
  return member ? `${member.lastName}, ${member.firstName}` : id.slice(0, 8);
}

/**
 * Deactivation and invite state are two different things and get two different
 * badges. A deactivated account whose invite also expired is deactivated first
 * — that is the one an administrator has to undo before anything else matters.
 *
 * A login with no invitation at all predates the invite flow (or is the seeded
 * administrator); it shows plain Active, because "never invited" is not a
 * problem to be fixed for those.
 */
function UserStatus({ user }: { user: User }) {
  if (!user.isActive) {
    return <Badge variant="outline">Inactive</Badge>;
  }

  if (!user.invitation) {
    return <Badge variant="secondary">Active</Badge>;
  }

  const status = invitationStatus(user.invitation);

  if (status === InvitationStatus.ACCEPTED) {
    return <Badge variant="secondary">Active</Badge>;
  }

  // A pending invite that never left the building is not the same as one
  // waiting to be opened, and only one of the two is the administrator's to fix.
  if (status === InvitationStatus.PENDING && user.invitation.deliveryError) {
    return (
      <Badge variant="destructive" title={user.invitation.deliveryError}>
        Invite not sent
      </Badge>
    );
  }

  return (
    <Badge variant={status === InvitationStatus.PENDING ? 'outline' : 'destructive'}>
      {INVITATION_STATUS_LABELS[status]}
    </Badge>
  );
}
