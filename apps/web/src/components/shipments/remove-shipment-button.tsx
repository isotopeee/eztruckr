'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserRole, isShipmentRemovableByDispatch, type Shipment } from '@eztruckr/types';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { ApiError } from '@/lib/api-client';
import { removeShipment, shipmentKeys } from '@/lib/shipment-api';
import { useCurrentUser } from '@/lib/use-current-user';

/**
 * Removing a trip: dispatch undoing a booking, or an administrator taking a
 * trip that ran out of the record.
 *
 * MIRRORS `CAN_REMOVE_DRAFT_SHIPMENTS`, `CAN_REMOVE_ANY_SHIPMENT` and
 * `isShipmentRemovableByDispatch`, which are what actually decide. Absent
 * rather than disabled for everybody else: a bin icon that always refuses
 * teaches people to click it and read an error, and this is the one control on
 * the screen that takes a trip out of every list.
 *
 * THE TWO REMOVALS ARE NOT THE SAME ACT, so they do not share a sentence. A
 * draft's is an undo; an administrator's on a trip that ran soft-deletes the
 * trip's charges, payments and cash accounts with it, and somebody about to do
 * that should be told so in the dialog rather than discover it afterwards.
 *
 * THE LAST BOUND IS NOT EXPRESSIBLE HERE and is not meant to be. Dispatch is
 * refused a draft that already carries a charge, a payment, released cash or an
 * adjustment; an administrator is refused a trip whose commission or adjustment
 * has been paid, or whose variance is being recovered. Both are facts about
 * rows this screen has not loaded, so the server names what is in the way and
 * the toast repeats it — more useful than a button greyed out for a reason
 * nobody can see.
 */
export function RemoveShipmentButton({ shipment }: { shipment: Shipment }) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const router = useRouter();

  const remove = useMutation({
    mutationFn: () => removeShipment(shipment.id),
    onSuccess: () => {
      // The detail query goes first, then the lists: a query for a trip that is
      // gone would refetch into a 404 while the router is still moving.
      queryClient.removeQueries({ queryKey: shipmentKeys.detail(shipment.id) });
      void queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
      toast.success(`Shipment ${shipment.shipmentNumber} removed`);
      router.push('/shipments');
    },
    onError: (error: unknown) => {
      toast.error('Could not remove this shipment', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      });
    },
  });

  const isAdministrator = user?.role === UserRole.ADMINISTRATOR;
  const isDispatch = user?.role === UserRole.OPERATIONS || user?.role === UserRole.DISPATCH_MANAGER;
  const isDraft = isShipmentRemovableByDispatch(shipment.status);

  if (!isAdministrator && !(isDispatch && isDraft)) {
    return null;
  }

  return (
    <ConfirmDeleteButton
      label={`Remove shipment ${shipment.shipmentNumber}`}
      title={
        isDraft
          ? `Remove booking ${shipment.shipmentNumber}?`
          : `Remove trip ${shipment.shipmentNumber}?`
      }
      description={
        isDraft
          ? 'The booking leaves every list and its empty cash accounts go with it. Nothing is destroyed — the row is kept, stamped with who removed it — and the number stays spent, so the next trip is numbered past it rather than reusing it.'
          : 'This trip has run. Removing it takes its charges, client payments, cash accounts and unpaid commissions with it, out of the P&L and out of every queue they sit in. Nothing is destroyed — each row is kept, stamped with who removed it — and anything already paid out will refuse.'
      }
      confirmLabel={isDraft ? 'Remove booking' : 'Remove trip'}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}
