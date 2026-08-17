'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserRole,
  areBookingDetailsCorrectable,
  type Client,
  type Page,
  type Route as RouteRecord,
  type Shipment,
} from '@eztruckr/types';
import { Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { ApiError, apiFetch } from '@/lib/api-client';
import { toDateInputValue } from '@/lib/format';
import { shipmentKeys, updateShipment } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

const NONE = '__none__';

/**
 * Correcting the facts that identify the trip.
 *
 * WHAT IS NOT HERE is the point of the card: no gross rate, no broker, no
 * cargo. Those shut at DRAFT and this form outlives dispatch, so offering them
 * together would be a form where half the fields silently stop working —
 * `updateRateChain` owns the money and the truck endpoint owns the truck.
 *
 * The lane comes with the route because origin and destination are SNAPSHOTTED
 * onto the shipment rather than read back through it: renaming a route must not
 * rewrite where old trips went, which is also why changing the route here has to
 * restate them rather than leave a Manila lane under a Davao route.
 */
export function BookingDetailsDialog({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);

  /**
   * Mirrors `CAN_WRITE_SHIPMENTS` and `areBookingDetailsCorrectable`, which are
   * what actually decide. The harder bound is not expressible here and is not
   * meant to be: changing the client or the route is refused once a commission
   * has been PAID, which this screen cannot know, so the refusal arrives from
   * the server naming how many were paid.
   */
  const mayEdit =
    (user?.role === UserRole.ADMINISTRATOR ||
      user?.role === UserRole.OPERATIONS ||
      user?.role === UserRole.DISPATCH_MANAGER) &&
    areBookingDetailsCorrectable(shipment.status);

  if (!mayEdit) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Pencil className="size-4" />
          Edit details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Trip details</DialogTitle>
          <DialogDescription>
            Who the trip was for, when it ran, and where. These stay correctable after dispatch —
            they are transcribed from paperwork that arrives later. The rate chain and the cargo are
            not: those are agreed at booking and have their own routes.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted per opening, so a cancelled edit does not leave half-typed
            values sitting behind a closed dialog. */}
        {open ? <DetailsForm shipment={shipment} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailsForm({ shipment, onDone }: { shipment: Shipment; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    clientId: shipment.clientId,
    routeId: shipment.routeId ?? NONE,
    shipmentDate: toDateInputValue(shipment.shipmentDate),
    origin: shipment.origin,
    destination: shipment.destination,
    containerNumber: shipment.containerNumber ?? '',
  });

  const clients = useQuery({
    queryKey: ['clients', 'picker'],
    queryFn: () => apiFetch<Page<Client>>('/clients?pageSize=200'),
  });

  const routes = useQuery({
    queryKey: ['routes', 'picker'],
    queryFn: () => apiFetch<Page<RouteRecord>>('/routes?pageSize=200'),
  });

  /**
   * Picking a route refills the lane, exactly as booking one does — and the
   * standard rate deliberately does NOT come with it, because the gross is
   * frozen by then and this form has no business sending it.
   */
  const chooseRoute = (routeId: string) => {
    const route = (routes.data?.items ?? []).find((entry) => entry.id === routeId);

    setForm((current) => ({
      ...current,
      routeId,
      ...(route ? { origin: route.origin, destination: route.destination } : {}),
    }));
  };

  /**
   * The two fields that move which commission rule applies, so the warning is
   * shown before saving rather than discovered in a recomputed payout.
   */
  const reScopesRules =
    form.clientId !== shipment.clientId ||
    (form.routeId === NONE ? null : form.routeId) !== shipment.routeId;

  const save = useMutation({
    mutationFn: () =>
      updateShipment(shipment.id, {
        clientId: form.clientId,
        routeId: form.routeId === NONE ? null : form.routeId,
        // A date-only input means midnight local; sent as an instant, because
        // storage is UTC and the display layer renders Asia/Manila.
        shipmentDate: new Date(form.shipmentDate).toISOString(),
        origin: form.origin,
        destination: form.destination,
        containerNumber: form.containerNumber || null,
      }),
    onSuccess: () => {
      toast.success('Trip details updated', {
        description: reScopesRules
          ? 'The client or route moved, so any computed commissions now report themselves stale — recompute them from the commissions card.'
          : undefined,
      });
      onDone();
      void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        toast.error('That change was refused', { description: error.displayMessage });
        return;
      }
      toast.error(String(error));
    },
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
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
        <Field id="shipmentDate" label="Shipment date" error={errors.shipmentDate}>
          <Input
            id="shipmentDate"
            type="date"
            required
            value={form.shipmentDate}
            onChange={(event) => set('shipmentDate')(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            The day the trip ran, from the paperwork — not the day it was booked, which is what the
            shipment number records.
          </p>
        </Field>
      </div>

      <Field id="routeId" label="Route" error={errors.routeId}>
        <Select value={form.routeId} onValueChange={chooseRoute}>
          <SelectTrigger id="routeId">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>One-off — no standard route</SelectItem>
            {(routes.data?.items ?? []).map((route) => (
              <SelectItem key={route.id} value={route.id}>
                {route.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Refills the lane below. It does not touch the gross rate — that was agreed at booking.
        </p>
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

      <Field id="containerNumber" label="Container no." error={errors.containerNumber}>
        <Input
          id="containerNumber"
          placeholder="Optional"
          value={form.containerNumber}
          onChange={(event) => set('containerNumber')(event.target.value)}
        />
      </Field>

      {reScopesRules ? (
        <p className="text-muted-foreground rounded-md border p-3 text-xs">
          Commission rules are scoped by client and route, so this change can select a different
          rule. Any commissions already computed will report themselves stale, and it is refused
          outright once one has been paid.
        </p>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Save details
        </Button>
      </DialogFooter>
    </form>
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
