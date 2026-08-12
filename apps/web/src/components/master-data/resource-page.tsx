'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page, RemovalResult } from '@eztruckr/types';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, apiFetch, queryString } from '@/lib/api-client';
import type { FormValues, ResourceSpec } from '@/lib/resource-spec';
import { useCurrentUser } from '@/lib/use-current-user';

interface WithIdAndActive {
  id: string;
  isActive: boolean;
}

/**
 * The one master data screen, parameterised.
 *
 * The part worth reading is `remove`: the API answers a delete with what it
 * actually did, and this reports that back verbatim rather than assuming.
 * A user who deactivates a truck by pressing Delete needs to be told, or they
 * will go looking for it in the deleted list and conclude the app lost it.
 */
export function ResourcePage<TRow extends WithIdAndActive>({ spec }: { spec: ResourceSpec<TRow> }) {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<TRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<TRow | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const canWrite = !!user && spec.writeRoles.includes(user.role);

  const listKey = [spec.key, { search, includeInactive }] as const;

  const { data, isPending, isError, error } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      apiFetch<Page<TRow>>(
        `${spec.apiPath}${queryString({ search, includeInactive, pageSize: 100 })}`,
      ),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [spec.key] });

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setValues({});
    setFieldErrors({});
  };

  const save = useMutation({
    mutationFn: async (payload: FormValues) => {
      const body = JSON.stringify(toRequestBody(payload, spec));

      return editing
        ? apiFetch<TRow>(`${spec.apiPath}/${editing.id}`, { method: 'PATCH', body })
        : apiFetch<TRow>(spec.apiPath, { method: 'POST', body });
    },
    onSuccess: async () => {
      toast.success(editing ? `${spec.singular} updated` : `${spec.singular} created`);
      closeForm();
      await invalidate();
    },
    onError: (mutationError) => {
      if (mutationError instanceof ApiError) {
        setFieldErrors(mutationError.fieldErrors);
        toast.error(mutationError.displayMessage);
        return;
      }
      toast.error('Something went wrong');
    },
  });

  const remove = useMutation({
    mutationFn: (row: TRow) =>
      apiFetch<RemovalResult>(`${spec.apiPath}/${row.id}`, { method: 'DELETE' }),
    onSuccess: async (result) => {
      toast.success(describeRemoval(result, spec.singular), {
        duration: result.outcome === 'DEACTIVATED' ? 8000 : 4000,
      });
      setRemoving(null);
      await invalidate();
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof ApiError ? mutationError.displayMessage : 'Something went wrong',
      );
      setRemoving(null);
    },
  });

  const formFields = useMemo(
    () => spec.fields.filter((field) => !field.createOnly || !editing),
    [spec.fields, editing],
  );

  const rows = data?.items ?? [];
  const isFormOpen = creating || editing !== null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{spec.title}</h1>
          <p className="text-muted-foreground text-sm">{spec.description}</p>
        </div>

        {canWrite ? (
          <Button
            onClick={() => {
              setValues(defaultValues(spec));
              setCreating(true);
            }}
          >
            <Plus className="size-4" />
            New {spec.singular.toLowerCase()}
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-4">
        <Input
          placeholder={`Search ${spec.title.toLowerCase()}…`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        <div className="flex items-center gap-2">
          <Switch
            id="include-inactive"
            checked={includeInactive}
            onCheckedChange={setIncludeInactive}
          />
          <Label htmlFor="include-inactive" className="text-muted-foreground text-sm">
            Show inactive
          </Label>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {spec.columns.map((column) => (
                <TableHead key={column.key} className={column.numeric ? 'text-right' : undefined}>
                  {column.label}
                </TableHead>
              ))}
              <TableHead>Status</TableHead>
              {canWrite ? <TableHead className="w-24 text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <MessageRow span={spec.columns.length + (canWrite ? 2 : 1)}>
                <Loader2 className="mr-2 inline size-4 animate-spin" />
                Loading…
              </MessageRow>
            ) : isError ? (
              <MessageRow span={spec.columns.length + (canWrite ? 2 : 1)}>
                <span className="text-destructive">
                  {error instanceof ApiError ? error.displayMessage : 'Could not load'}
                </span>
              </MessageRow>
            ) : rows.length === 0 ? (
              <MessageRow span={spec.columns.length + (canWrite ? 2 : 1)}>
                Nothing here yet.
              </MessageRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? undefined : 'opacity-60'}>
                  {spec.columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={column.numeric ? 'text-right tabular-nums' : undefined}
                    >
                      {column.render(row)}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Badge variant={row.isActive ? 'secondary' : 'outline'}>
                      {row.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${spec.singular.toLowerCase()}`}
                        onClick={() => {
                          setValues(spec.toFormValues(row));
                          setEditing(row);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${spec.singular.toLowerCase()}`}
                        onClick={() => setRemoving(row)}
                      >
                        <Trash2 className="text-destructive size-4" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data ? (
        <p className="text-muted-foreground text-xs">
          {data.total} {data.total === 1 ? 'record' : 'records'}
          {includeInactive ? '' : ', active only'}
        </p>
      ) : null}

      <Dialog open={isFormOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Edit ${spec.singular.toLowerCase()}`
                : `New ${spec.singular.toLowerCase()}`}
            </DialogTitle>
            <DialogDescription>{spec.description}</DialogDescription>
          </DialogHeader>

          <form
            id="resource-form"
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
            <Button type="submit" form="resource-form" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this {spec.singular.toLowerCase()}?</DialogTitle>
            <DialogDescription>
              {spec.removalNote ??
                'If anything already refers to this record it will be deactivated instead of removed, so existing paperwork keeps reading correctly.'}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={remove.isPending}>
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

function MessageRow({ span, children }: { span: number; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={span} className="text-muted-foreground py-10 text-center">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** Says what happened, and why, in the user's terms. */
function describeRemoval(result: RemovalResult, singular: string): string {
  const noun = singular.toLowerCase();

  if (result.outcome === 'DEACTIVATED') {
    const referredBy = result.references
      .map((reference) => `${reference.count} ${reference.entity}`)
      .join(', ');

    return `Deactivated instead of removed — ${referredBy} still refer to this ${noun}. It stays on existing records but is no longer offered for new ones.`;
  }

  return result.outcome === 'HARD_DELETED'
    ? `${singular} deleted. Nothing referred to it.`
    : `${singular} removed.`;
}

function defaultValues<TRow>(spec: ResourceSpec<TRow>): FormValues {
  const values: FormValues = {};

  for (const field of spec.fields) {
    if (field.type === 'boolean') values[field.name] = field.name === 'isActive';
    else if (field.type === 'multiselect') values[field.name] = [];
    else values[field.name] = '';
  }

  return values;
}

/**
 * Turns form state into a request body.
 *
 * Empty strings become null rather than "", so clearing a field in the UI and
 * omitting it in an API call mean the same thing. Dates become the ISO instants
 * the API expects; storage is UTC and Asia/Manila is applied only for display.
 */
function toRequestBody<TRow>(values: FormValues, spec: ResourceSpec<TRow>): FormValues {
  const body: FormValues = {};

  for (const field of spec.fields) {
    const value = values[field.name];

    if (value === undefined) continue;

    if (field.type === 'boolean') {
      body[field.name] = value === true;
      continue;
    }

    if (field.type === 'multiselect') {
      body[field.name] = Array.isArray(value) ? value.map(Number) : [];
      continue;
    }

    if (typeof value === 'string' && value.trim() === '') {
      // Clearing an optional field means null — the API normalises "" to null
      // anyway, and null is what "no value" is in the database.
      //
      // A REQUIRED field is left as "" instead. Sending null would make the
      // schema complain about the type ("expected string, received null")
      // where the empty string draws its own rule ("must be at least 2
      // characters") — the difference between a stack trace and an
      // instruction.
      body[field.name] = field.required ? '' : null;
      continue;
    }

    if (field.type === 'date' && typeof value === 'string') {
      body[field.name] = new Date(`${value}T00:00:00Z`).toISOString();
      continue;
    }

    if (field.type === 'integer' && typeof value === 'string') {
      body[field.name] = Number(value);
      continue;
    }

    if (field.type === 'select' && typeof value === 'string' && /^\d+$/.test(value)) {
      // Code sets cross the wire as numbers; a select only ever holds strings.
      body[field.name] = Number(value);
      continue;
    }

    body[field.name] = value;
  }

  return body;
}
