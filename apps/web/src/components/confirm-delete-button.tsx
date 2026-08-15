'use client';

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * A bin icon that asks first.
 *
 * WHY EVERY DELETE ON THESE SCREENS GOES THROUGH ONE COMPONENT. The shipment
 * cards each grew their own bin button, and each one fired its mutation
 * straight from `onClick` — a single mis-click on a phone removed a cash
 * release, a claimed expense or a rebill with no way back on the screen. The
 * master-data pages and the users page had confirmation dialogs of their own
 * all along, so the money screens were the ones behaving differently, which is
 * the wrong way round.
 *
 * It is deliberately NOT a wrapper the cards can forget to use: it renders the
 * trigger as well as the dialog, so there is no way to place the button here
 * without the question attached to it.
 *
 * NOTHING IS UNDONE BY CANCELLING — the dialog is asked before anything is
 * sent, not after. What the delete then means is the API's business: a release
 * is soft-deleted, a master-data record may turn out to be deactivated instead,
 * and the caller's own error toast reports a refusal.
 */
export function ConfirmDeleteButton({
  label,
  title,
  description,
  confirmLabel = 'Remove',
  pending = false,
  disabled = false,
  onConfirm,
}: {
  /** Names the row for screen readers, e.g. "Remove Diesel". */
  label: string;
  title: string;
  /** What removing it actually does — the consequence, not a restatement. */
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        disabled={disabled || pending}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                // Closed here rather than in the caller's `onSuccess`: the
                // mutation belongs to the list, which re-renders without this
                // row, and a dialog waiting on a component that has gone is a
                // dialog left open over the wrong record.
                setOpen(false);
                onConfirm();
              }}
            >
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
