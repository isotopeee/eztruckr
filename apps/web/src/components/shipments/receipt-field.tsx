'use client';

import { useRef, useState } from 'react';
import { ALLOWED_RECEIPT_MIME_TYPES } from '@eztruckr/types';
import { Loader2, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { uploadReceipt } from '@/lib/liquidation-api';

/**
 * Attach a file, get an id back.
 *
 * The upload happens as soon as a file is chosen, not when the surrounding form
 * is saved. That is the same split the API makes and for the same reason: a
 * form that fails validation should not have already put bytes in the bucket,
 * and a retry should not upload them twice.
 */
export function ReceiptField({
  value,
  fileName,
  onChange,
  label = 'Attachment',
}: {
  value: string | null;
  fileName: string | null;
  onChange: (receiptId: string | null, fileName: string | null) => void;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;

    setUploading(true);
    try {
      const receipt = await uploadReceipt(file);
      onChange(receipt.id, receipt.fileName);
    } catch (error) {
      toast.error('Could not upload that file', {
        description: error instanceof ApiError ? error.displayMessage : String(error),
      });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  if (value) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Paperclip className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="truncate">{fileName ?? 'Attached'}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove attachment"
          onClick={() => onChange(null, null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={ALLOWED_RECEIPT_MIME_TYPES.join(',')}
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => input.current?.click()}
      >
        {uploading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Paperclip className="mr-2 h-4 w-4" />
        )}
        {label}
      </Button>
      <span className="text-muted-foreground text-xs">Optional</span>
    </div>
  );
}
