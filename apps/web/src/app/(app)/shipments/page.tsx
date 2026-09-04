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
  type Route as RouteRecord,
  type ShipmentSortField,
  type SortDirection,
  type ThirdParty,
  type Truck,
} from '@eztruckr/types';
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from 'lucide-react';
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
import { formatDate, formatMoney } from '@/lib/format';
import { createShipment, listShipments, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';
import { cn } from '@/lib/utils';

const ALL = '__all__';
const NONE = '__none__';

/**
 * Which way a column runs the FIRST time it is clicked.
 *
 * Not one answer for every column: the useful end of a date, a shipment number
 * (which is a date with a sequence on it) and a peso figure is the large end,
 * while a name or a container number is read from A. Starting each where its
 * reader starts saves the second click that otherwise always follows the first.
 */
const FIRST_DIRECTION: Readonly<Record<ShipmentSortField, SortDirection>> = {
  date: 'desc',
  number: 'desc',
  client: 'asc',
  container: 'asc',
  netRate: 'desc',
  status: 'asc',
};

export default function Page() {
  const { user } = useCurrentUser();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [sort, setSort] = useState<ShipmentSortField>('date');
  const [direction, setDirection] = useState<SortDirection>('desc');

  /**
   * The money columns are dropped for crew rather than shown empty.
   *
   * The API serves them nulls there (`redactRevenueForCrew`), so keeping them
   * would print headings about freight revenue and what a client owes over
   * columns of "—", which reads as a broken screen and still tells them the
   * figures exist.
   */
  const showRevenue = user?.role !== UserRole.CREW;

  const filters = {
    page: 1,
    search,
    status: status === ALL ? undefined : (Number(status) as ShipmentStatus),
    sort,
    direction,
  };

  /**
   * Clicking a heading. The same one flips direction; a different one starts
   * at whichever end that column is normally read from.
   *
   * The ordering is sent to the API rather than applied to `rows`, because
   * `rows` is one page: sorting it here would order twenty-five trips out of
   * however many match, and label the result "by net rate".
   */
  const sortBy = (field: ShipmentSortField) => {
    if (field === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSort(field);
    setDirection(FIRST_DIRECTION[field]);
  };

  const shipments = useQuery({
    queryKey: shipmentKeys.list(filters),
    queryFn: () => listShipments(filters),
  });

  // `CAN_WRITE_SHIPMENTS` on the API, which has included the dispatch manager
  // since they existed — this list had not, so booking was refused in the
  // browser for a role the server was happy to accept.
  const canCreate =
    user?.role === UserRole.ADMINISTRATOR ||
    user?.role === UserRole.OPERATIONS ||
    user?.role === UserRole.DISPATCH_MANAGER;
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
              placeholder="Number, container, origin or destination"
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
                  <SortableHead
                    field="number"
                    label="Number"
                    sort={sort}
                    direction={direction}
                    onSort={sortBy}
                  />
                  <SortableHead
                    field="date"
                    label="Date"
                    sort={sort}
                    direction={direction}
                    onSort={sortBy}
                  />
                  <SortableHead
                    field="client"
                    label="Client"
                    sort={sort}
                    direction={direction}
                    onSort={sortBy}
                  />
                  <TableHead>Route</TableHead>
                  <SortableHead
                    field="container"
                    label="Container"
                    sort={sort}
                    direction={direction}
                    onSort={sortBy}
                  />
                  <TableHead>Truck</TableHead>
                  {showRevenue ? (
                    <>
                      <SortableHead
                        field="netRate"
                        label="Net rate"
                        className="text-right"
                        sort={sort}
                        direction={direction}
                        onSort={sortBy}
                      />
                      {/* Not sortable, unlike the net rate beside them: both are
                          summed per trip after the page has been chosen, so a
                          heading offering to order by them could only order the
                          twenty-five rows already fetched — the bug the note on
                          `orderFor` exists to prevent. */}
                      <TableHead className="text-right">Total billed</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </>
                  ) : null}
                  <SortableHead
                    field="status"
                    label="Status"
                    sort={sort}
                    direction={direction}
                    onSort={sortBy}
                  />
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
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {formatDate(shipment.shipmentDate)}
                    </TableCell>
                    <TableCell>{shipment.clientName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {shipment.origin} → {shipment.destination}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {shipment.containerNumber ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {shipment.truckPlateNumber ?? 'no truck'}
                    </TableCell>
                    {showRevenue ? (
                      <>
                        <TableCell className="text-right tabular-nums">
                          {shipment.netRate === null ? '—' : formatMoney(shipment.netRate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {shipment.amountDue === null ? '—' : formatMoney(shipment.amountDue)}
                        </TableCell>
                        {/* Settled reads quieter than outstanding: a zero
                            balance is the row nobody has to act on, and a
                            negative one is money owed back, which is not the
                            same news as money owed. */}
                        <TableCell
                          className={cn(
                            'text-right font-medium tabular-nums',
                            shipment.balance === null || shipment.balance === '0.00'
                              ? 'text-muted-foreground font-normal'
                              : shipment.balance.startsWith('-')
                                ? 'text-destructive'
                                : undefined,
                          )}
                        >
                          {shipment.balance === null ? '—' : formatMoney(shipment.balance)}
                        </TableCell>
                      </>
                    ) : null}
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
 * A column heading that sorts.
 *
 * A real `<button>` inside the `<th>` rather than a click handler on the cell,
 * so the heading is reachable and operable from the keyboard; `aria-sort`
 * carries the current ordering to a screen reader, which is the only way it is
 * announced — the arrow is decorative and hidden from the tree.
 */
function SortableHead({
  field,
  label,
  sort,
  direction,
  onSort,
  className,
}: {
  field: ShipmentSortField;
  label: string;
  sort: ShipmentSortField;
  direction: SortDirection;
  onSort: (field: ShipmentSortField) => void;
  className?: string;
}) {
  const active = field === sort;
  // Unsorted columns show the neutral pair, so a heading looks sortable before
  // anybody has clicked it rather than only after.
  const Icon = !active ? ChevronsUpDown : direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TableHead
      className={className}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
        <Icon aria-hidden className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-50')} />
      </button>
    </TableHead>
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
    clientId: '',
    thirdPartyId: NONE,
    routeId: NONE,
    truckId: NONE,
    // Today, and editable: a trip booked on Monday for a run that happened on
    // Friday is ordinary, and the shipment number's date part records when the
    // row was made rather than when the truck moved.
    shipmentDate: new Date().toISOString().slice(0, 10),
    origin: '',
    destination: '',
    containerNumber: '',
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

  const routes = useQuery({
    queryKey: ['routes', 'picker'],
    queryFn: () => apiFetch<PageResult<RouteRecord>>('/routes?pageSize=200'),
    enabled: open,
  });

  const trucks = useQuery({
    queryKey: ['trucks', 'picker'],
    queryFn: () => apiFetch<PageResult<Truck>>('/trucks?pageSize=200'),
    enabled: open,
  });

  const hasBroker = form.thirdPartyId !== NONE;

  /**
   * Picking a route fills in what the route already knows.
   *
   * Origin and destination are SNAPSHOTTED onto the shipment rather than read
   * through the route, so that renaming a route later cannot rewrite where old
   * trips went — which means they have to be copied at some point, and this is
   * it. The standard rate is prefilled for the same reason the column exists;
   * every one of the three stays editable, because what was agreed on the day
   * beats what the route usually is.
   */
  const chooseRoute = (routeId: string) => {
    const route = (routes.data?.items ?? []).find((entry) => entry.id === routeId);

    setForm((current) => ({
      ...current,
      routeId,
      ...(route
        ? {
            origin: route.origin,
            destination: route.destination,
            grossRate: route.standardRate ?? current.grossRate,
          }
        : {}),
    }));
  };

  const create = useMutation({
    mutationFn: () =>
      createShipment({
        clientId: form.clientId,
        thirdPartyId: hasBroker ? form.thirdPartyId : null,
        routeId: form.routeId === NONE ? null : form.routeId,
        truckId: form.truckId === NONE ? null : form.truckId,
        // A date-only input means midnight local; sent as an instant, because
        // storage is UTC and the display layer renders Asia/Manila.
        shipmentDate: new Date(form.shipmentDate).toISOString(),
        origin: form.origin,
        destination: form.destination,
        cargoDescription: null,
        containerNumber: form.containerNumber || null,
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
            Starts as a draft, numbered automatically — today&apos;s date and the trip&apos;s
            position in it, like 20260813001. The rate chain can only be edited while it is a draft.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
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
              Fills in the lane and the standard rate, and carries this route&apos;s standard
              allowance through to the trip&apos;s first cash release. All still editable.
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

          <div className="grid grid-cols-2 gap-3">
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
            <Field id="containerNumber" label="Container no." error={errors.containerNumber}>
              <Input
                id="containerNumber"
                placeholder="Optional"
                value={form.containerNumber}
                onChange={(event) => set('containerNumber')(event.target.value)}
              />
            </Field>
          </div>

          <Field id="truckId" label="Truck" error={errors.truckId}>
            <Select value={form.truckId} onValueChange={set('truckId')}>
              <SelectTrigger id="truckId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Assign later</SelectItem>
                {(trucks.data?.items ?? []).map((truck) => (
                  <SelectItem key={truck.id} value={truck.id}>
                    {truck.plateNumber}
                    {truck.bodyType ? ` · ${truck.bodyType}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Optional now, required to dispatch — assign it here or on the trip itself.
            </p>
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
