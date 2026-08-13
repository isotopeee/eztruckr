'use client';

import { useQuery } from '@tanstack/react-query';
import { StaffRole, type Page, type Shipment, type Staff } from '@eztruckr/types';
import { apiFetch } from '@/lib/api-client';

export interface TripPerson {
  id: string;
  name: string;
  /** Shown beside the name when it is not obvious why they are on the list. */
  note?: string;
}

/**
 * The people in this trip's crew slots.
 *
 * Driver first, because that is the order every one of these forms defaults in.
 */
export function crewOnTrip(shipment: Shipment): TripPerson[] {
  return [
    shipment.driverId ? { id: shipment.driverId, name: shipment.driverName ?? 'Driver' } : null,
    shipment.helperId ? { id: shipment.helperId, name: shipment.helperName ?? 'Helper' } : null,
  ].filter((entry): entry is TripPerson => entry !== null);
}

/**
 * Everyone this trip's cash may be entrusted to.
 *
 * The crew in its slots, plus every active DISPATCH MANAGER — who hold a trip's
 * float without driving or helping, and are therefore not attached to the
 * shipment at all. That is why they are fetched rather than read off the
 * shipment: there is no slot to read them from, by design.
 *
 * Three separate forms ask this — who may be made custodian of an account, who
 * a release may be handed to, and whose pay a carried balance may be charged to
 * — and the API refuses all three the same way, through
 * `assertMayHoldTripCash`. Built once here so the refusal is something the
 * screens avoid rather than something they discover.
 */
export function useTripCashHolders(shipment: Shipment): TripPerson[] {
  const staff = useQuery({
    queryKey: ['staff', 'dispatch-managers'],
    queryFn: () => apiFetch<Page<Staff>>('/staff?pageSize=200'),
  });

  const crew = crewOnTrip(shipment);
  const inASlot = new Set(crew.map((person) => person.id));

  const dispatchManagers = (staff.data?.items ?? [])
    .filter(
      (person) =>
        person.isActive &&
        person.eligibleRoles.includes(StaffRole.DISPATCH_MANAGER) &&
        // Somebody eligible to drive AND to dispatch, who is driving this trip,
        // is already in the list under the slot they are actually filling.
        !inASlot.has(person.id),
    )
    .map((person) => ({
      id: person.id,
      name: `${person.firstName} ${person.lastName}`,
      note: 'dispatch manager',
    }));

  return [...crew, ...dispatchManagers];
}
