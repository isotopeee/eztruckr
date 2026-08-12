'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PASSWORD_MIN_LENGTH,
  USER_ROLE_LABELS,
  UserRole,
  type CrewMember,
  type Page,
  type RemovalResult,
  type User,
} from '@eztruckr/types';
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
 * takes a password, changing one takes a separate endpoint, and the crew link
 * is conditional on the role. Forcing it into the generic screen would mean
 * bending the generic screen out of shape for the one case that differs.
 */
export default function UsersPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);
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
    queryKey: ['crew-members', 'for-linking'],
    queryFn: () => apiFetch<Page<CrewMember>>('/crew-members?pageSize=200'),
  });

  const linkedCrewIds = new Set(
    (users.data?.items ?? [])
      .filter((user) => user.crewMemberId && user.id !== editing?.id)
      .map((user) => user.crewMemberId),
  );

  const fields: FieldSpec[] = [
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'password',
      label: 'Initial password',
      type: 'password',
      required: true,
      createOnly: true,
      help: `At least ${PASSWORD_MIN_LENGTH} characters. Hand it over directly; there is no email flow.`,
    },
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
      name: 'crewMemberId',
      label: 'Linked crew member',
      type: 'select',
      options: (crew.data?.items ?? [])
        .filter((member) => !linkedCrewIds.has(member.id))
        .map((member) => ({
          value: member.id,
          label: `${member.employeeCode} — ${member.lastName}, ${member.firstName}`,
        })),
      help: 'Required for a crew login, and forbidden for any other role.',
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
        crewMemberId: payload.crewMemberId ? payload.crewMemberId : null,
        isActive: payload.isActive === true,
      });

      return editing
        ? apiFetch<User>(`/users/${editing.id}`, { method: 'PATCH', body })
        : apiFetch<User>('/users', { method: 'POST', body });
    },
    onSuccess: async () => {
      toast.success(editing ? 'Login updated' : 'Login created');
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
            Logins and roles. There is no public sign-up — every account is created here.
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
              <TableHead>Crew link</TableHead>
              <TableHead>Last signed in</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
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
                    {user.crewMemberId ? crewLabel(crew.data?.items ?? [], user.crewMemberId) : '—'}
                  </TableCell>
                  <TableCell>
                    {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.isActive ? 'secondary' : 'outline'}>
                      {user.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
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
                          crewMemberId: user.crewMemberId ?? '',
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

function crewLabel(members: CrewMember[], id: string): string {
  const member = members.find((entry) => entry.id === id);
  return member ? member.employeeCode : id.slice(0, 8);
}
