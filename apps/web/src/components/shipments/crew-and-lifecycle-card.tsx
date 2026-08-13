'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CrewRole,
  SHIPMENT_STATUS_LABELS,
  UserRole,
  allowedManualTransitions,
  type CrewMember,
  type Page,
  type Shipment,
  type ShipmentStatus,
  type Truck,
} from '@eztruckr/types';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { assignCrew, assignTruck, shipmentKeys, transitionShipment } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

const UNASSIGNED = '__none__';

/**
 * Crew assignment and the status lifecycle.
 *
 * The role dropdowns are filtered by eligibility, but that filtering is a
 * convenience — the API re-checks it, along with the driver's licence, because
 * a dropdown is not a control. The transition buttons come from
 * `allowedManualTransitions`, the same table the server uses, so the UI cannot
 * offer a move the server will refuse.
 */
export function CrewAndLifecycleCard({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [driverId, setDriverId] = useState(shipment.driverId ?? UNASSIGNED);
  const [helperId, setHelperId] = useState(shipment.helperId ?? UNASSIGNED);
  const [truckId, setTruckId] = useState(shipment.truckId ?? UNASSIGNED);

  const canDispatch = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.OPERATIONS;
  const canClose = user?.role === UserRole.ADMINISTRATOR || user?.role === UserRole.ACCOUNTING;

  useEffect(() => {
    setDriverId(shipment.driverId ?? UNASSIGNED);
    setHelperId(shipment.helperId ?? UNASSIGNED);
    setTruckId(shipment.truckId ?? UNASSIGNED);
  }, [shipment.driverId, shipment.helperId, shipment.truckId]);

  const crew = useQuery({
    queryKey: ['crew-members', 'assignable'],
    queryFn: () => apiFetch<Page<CrewMember>>('/crew-members?pageSize=200'),
  });

  const trucks = useQuery({
    queryKey: ['trucks', 'assignable'],
    queryFn: () => apiFetch<Page<Truck>>('/trucks?pageSize=200'),
  });

  const onError = (error: unknown) => {
    toast.error('That change was refused', {
      description: error instanceof ApiError ? error.displayMessage : String(error),
    });
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: shipmentKeys.all });

  const save = useMutation({
    mutationFn: () =>
      assignCrew(shipment.id, {
        driverId: driverId === UNASSIGNED ? null : driverId,
        helperId: helperId === UNASSIGNED ? null : helperId,
      }),
    onSuccess: () => {
      toast.success('Crew updated');
      void invalidate();
    },
    onError,
  });

  /**
   * Saved on its own, not with the crew.
   *
   * They are two decisions with two rules — the crew freeze when a commission
   * is paid, the truck only when the trip closes — so one Save button covering
   * both would have to disable itself on the stricter of the two and take a
   * legitimate truck correction down with it.
   */
  const saveTruck = useMutation({
    mutationFn: () => assignTruck(shipment.id, truckId === UNASSIGNED ? null : truckId),
    onSuccess: () => {
      toast.success('Truck updated');
      void invalidate();
    },
    onError,
  });

  const move = useMutation({
    mutationFn: (to: ShipmentStatus) => transitionShipment(shipment.id, to),
    onSuccess: (updated) => {
      toast.success(`Shipment is now ${SHIPMENT_STATUS_LABELS[updated.status].toLowerCase()}`);
      void invalidate();
    },
    onError,
  });

  const members = crew.data?.items ?? [];
  const drivers = members.filter((member) => member.eligibleRoles.includes(CrewRole.DRIVER));
  const helpers = members.filter((member) => member.eligibleRoles.includes(CrewRole.HELPER));
  const transitions = allowedManualTransitions(shipment.status);

  const mayDrive = (to: ShipmentStatus) => (to === 7 ? canClose : canDispatch);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Crew, truck and progress</CardTitle>
        <CardDescription>
          A role belongs to the trip, not the person — the same crew member can drive one and help
          on another. Dispatch needs a driver and a truck.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="space-y-3">
          <CrewSlot
            id="driver"
            label="Driver"
            value={driverId}
            onChange={setDriverId}
            options={drivers}
            disabled={!canDispatch}
            note="Needs a current licence — checked server-side when assigned."
          />
          <CrewSlot
            id="helper"
            label="Helper"
            value={helperId}
            onChange={setHelperId}
            options={helpers}
            disabled={!canDispatch}
          />
          {canDispatch ? (
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save crew
            </Button>
          ) : null}
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="truck" className="text-muted-foreground text-xs">
              Truck
            </Label>
            <Select value={truckId} onValueChange={setTruckId} disabled={!canDispatch}>
              <SelectTrigger id="truck">
                <SelectValue placeholder="No truck assigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>No truck</SelectItem>
                {(trucks.data?.items ?? []).map((truck) => (
                  <SelectItem key={truck.id} value={truck.id}>
                    {truck.plateNumber}
                    {truck.bodyType ? ` · ${truck.bodyType}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              A truck feeds no commission, so unlike the crew it stays correctable until the trip
              closes — a roadside swap can be recorded after the fact.
            </p>
          </div>
          {canDispatch ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => saveTruck.mutate()}
              disabled={saveTruck.isPending}
            >
              {saveTruck.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save truck
            </Button>
          ) : null}
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Status</span>
            <Badge>{SHIPMENT_STATUS_LABELS[shipment.status]}</Badge>
          </div>

          <dl className="text-muted-foreground grid grid-cols-2 gap-1 text-xs">
            {shipment.dispatchedAt ? (
              <>
                <dt>Dispatched</dt>
                <dd>{formatDateTime(shipment.dispatchedAt)}</dd>
              </>
            ) : null}
            {shipment.deliveredAt ? (
              <>
                <dt>Delivered</dt>
                <dd>{formatDateTime(shipment.deliveredAt)}</dd>
              </>
            ) : null}
            {shipment.closedAt ? (
              <>
                <dt>Closed</dt>
                <dd>{formatDateTime(shipment.closedAt)}</dd>
              </>
            ) : null}
          </dl>

          {transitions.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {shipment.status === 5
                ? 'Becomes liquidated on its own once the liquidation is approved and commissions are computed. That step is earned, not requested.'
                : 'No further step from here.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {transitions.map((to) => (
                <Button
                  key={to}
                  size="sm"
                  variant="outline"
                  disabled={move.isPending || !mayDrive(to)}
                  onClick={() => move.mutate(to)}
                >
                  Mark {SHIPMENT_STATUS_LABELS[to].toLowerCase()}
                </Button>
              ))}
            </div>
          )}

          {transitions.includes(4) ? (
            <p className="text-muted-foreground text-xs">
              Marking it delivered moves it straight to pending liquidation, so it shows up as
              awaiting accounting rather than sitting in a state nobody queries.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function CrewSlot({
  id,
  label,
  value,
  onChange,
  options,
  disabled,
  note,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: CrewMember[];
  disabled: boolean;
  note?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
          {options.map((member) => (
            <SelectItem key={member.id} value={member.id}>
              {member.firstName} {member.lastName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}
