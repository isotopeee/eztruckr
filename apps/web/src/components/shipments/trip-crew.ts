import type { Shipment } from '@eztruckr/types';

export interface TripCrewMember {
  id: string;
  name: string;
}

/**
 * The people on this trip, for the pickers that must not offer anybody else.
 *
 * Three separate screens ask this question — who may be handed cash, who may be
 * made custodian of it, whose pay a balance may be recovered from — and the API
 * refuses all three the same way: a crew member who was not on the trip is
 * either a typo or a problem. Built once here so the refusal is something the
 * screens avoid rather than something they discover.
 *
 * Driver first, because that is the order every one of those forms defaults in.
 */
export function crewOnTrip(shipment: Shipment): TripCrewMember[] {
  return [
    shipment.driverId ? { id: shipment.driverId, name: shipment.driverName ?? 'Driver' } : null,
    shipment.helperId ? { id: shipment.helperId, name: shipment.helperName ?? 'Helper' } : null,
  ].filter((entry): entry is TripCrewMember => entry !== null);
}
