'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SHIPMENT_STATUS_CODES,
  SHIPMENT_STATUS_LABELS,
  ShipmentStatus,
  UserRole,
  type Client,
  type Page as PageResult,
  type ThirdParty,
} from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { createShipment, listShipments, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

const ALL = '__all__';
const NONE = '__none__';

export default function Page() {
  const { user } = useCurrentUser();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);

  const filters = {
    page: 1,
    search,
    status: status === ALL ? undefined : (Number(status) as ShipmentStatus),
  };

  const shipments = useQuery({
    queryKey: shipmentKeys.list(filters),
    queryFn: () => listShipments(filters),
  });

  const canCreate = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.OPERATIONS;
  const rows = shipments.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Shipments</h1>
          <p className="text-muted-foreground text-sm">
            {user?.role === UserRole.CREW
              ? 'The trips you worked on.'
              : 'Every trip, from booking through to close.'}
          </p>
        </div>
        {canCreate ? <CreateShipmentDialog /> : null}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="search">Search</Label>
            <Input
              id="search"
              placeholder="Number, origin or destination"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="w-full space-y-1 sm:w-56">
            <Label htmlFor="status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {SHIPMENT_STATUS_CODES.map((code) => (
                  <SelectItem key={code} value={String(code)}>
                    {SHIPMENT_STATUS_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {shipments.isPending ? (
            <p className="text-muted-foreground py-6 text-sm">Loading…</p>
          ) : shipments.isError ? (
            <p className="text-destructive py-6 text-sm">
              {shipments.error instanceof ApiError
                ? shipments.error.displayMessage
                : 'Could not load shipments.'}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground py-6 text-sm">No shipments match.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Crew</TableHead>
                  <TableHead className="text-right">Net rate</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((shipment) => (
                  <TableRow key={shipment.id}>
                    <TableCell>
                      <Link
                        href={`/shipments/${shipment.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {shipment.shipmentNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{shipment.clientName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {shipment.origin} → {shipment.destination}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {shipment.driverName ?? 'no driver'}
                      {shipment.helperName ? ` · ${shipment.helperName}` : ''}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(shipment.netRate)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          shipment.status === ShipmentStatus.PENDING_LIQUIDATION
                            ? 'default'
                            : 'secondary'
                        }
                      >
                        {SHIPMENT_STATUS_LABELS[shipment.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Booking a trip.
 *
 * The broker cut is entered as either a percentage or a flat amount, never
 * both — which one was agreed is what the shipment records, so that a later
 * change to the broker's standard rate cannot rewrite what this trip paid.
 */
function CreateShipmentDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    shipmentNumber: '',
    clientId: '',
    thirdPartyId: NONE,
    origin: '',
    destination: '',
    grossRate: '',
    tpcMode: 'rate' as 'rate' | 'amount',
    tpcValue: '',
  });

  const clients = useQuery({
    queryKey: ['clients', 'picker'],
    queryFn: () => apiFetch<PageResult<Client>>('/clients?pageSize=200'),
    enabled: open,
  });

  const brokers = useQuery({
    queryKey: ['third-parties', 'picker'],
    queryFn: () => apiFetch<PageResult<ThirdParty>>('/third-parties?pageSize=200'),
    enabled: open,
  });

  const hasBroker = form.thirdPartyId !== NONE;

  const create = useMutation({
    mutationFn: () =>
      createShipment({
        shipmentNumber: form.shipmentNumber,
        clientId: form.clientId,
        thirdPartyId: hasBroker ? form.thirdPartyId : null,
        routeId: null,
        truckId: null,
        origin: form.origin,
        destination: form.destination,
        cargoDescription: null,
        grossRate: form.grossRate,
        tpcRate: hasBroker && form.tpcMode === 'rate' && form.tpcValue ? form.tpcValue : null,
        tpcAmount: hasBroker && form.tpcMode === 'amount' && form.tpcValue ? form.tpcValue : null,
      }),
    onSuccess: () => {
      toast.success('Shipment created as a draft');
      setOpen(false);
      setErrors({});
      void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        toast.error(error.displayMessage);
        return;
      }
      toast.error(String(error));
    },
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New shipment</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New shipment</DialogTitle>
          <DialogDescription>
            Starts as a draft. The rate chain can only be edited while it is one.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field id="shipmentNumber" label="Shipment number" error={errors.shipmentNumber}>
            <Input
              id="shipmentNumber"
              required
              value={form.shipmentNumber}
              onChange={(event) => set('shipmentNumber')(event.target.value)}
            />
          </Field>

          <Field id="clientId" label="Client" error={errors.clientId}>
            <Select value={form.clientId} onValueChange={set('clientId')}>
              <SelectTrigger id="clientId">
                <SelectValue placeholder="Choose a client" />
              </SelectTrigger>
              <SelectContent>
                {(clients.data?.items ?? []).map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="origin" label="Origin" error={errors.origin}>
              <Input
                id="origin"
                required
                value={form.origin}
                onChange={(event) => set('origin')(event.target.value)}
              />
            </Field>
            <Field id="destination" label="Destination" error={errors.destination}>
              <Input
                id="destination"
                required
                value={form.destination}
                onChange={(event) => set('destination')(event.target.value)}
              />
            </Field>
          </div>

          <Field id="grossRate" label="Gross rate" error={errors.grossRate}>
            <Input
              id="grossRate"
              inputMode="decimal"
              required
              placeholder="18000.00"
              value={form.grossRate}
              onChange={(event) => set('grossRate')(event.target.value)}
            />
          </Field>

          <Field id="thirdPartyId" label="Third party (broker)" error={errors.thirdPartyId}>
            <Select value={form.thirdPartyId} onValueChange={set('thirdPartyId')}>
              <SelectTrigger id="thirdPartyId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Direct client — no broker cut</SelectItem>
                {(brokers.data?.items ?? []).map((broker) => (
                  <SelectItem key={broker.id} value={broker.id}>
                    {broker.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {hasBroker ? (
            <div className="grid grid-cols-[10rem_1fr] gap-3">
              <Field id="tpcMode" label="Cut agreed as">
                <Select
                  value={form.tpcMode}
                  onValueChange={(value) => set('tpcMode')(value as 'rate' | 'amount')}
                >
                  <SelectTrigger id="tpcMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rate">% of gross</SelectItem>
                    <SelectItem value="amount">Flat amount</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field
                id="tpcValue"
                label={form.tpcMode === 'rate' ? 'Rate (0.10 = 10%)' : 'Amount'}
                error={errors.tpcAmount ?? errors.tpcRate}
              >
                <Input
                  id="tpcValue"
                  inputMode="decimal"
                  value={form.tpcValue}
                  onChange={(event) => set('tpcValue')(event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
