'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Within the API's `pageSize` ceiling of 200. */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

interface ListPagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** True while the next page is in flight, so a second click cannot skip one. */
  busy?: boolean;
}

/**
 * Previous / next under a server-paginated list, with the "x–y of n" count and
 * a rows-per-page choice.
 *
 * Hidden only when the list fits in the smallest page size. Hiding it whenever
 * the list fits on one page would remove the control after a reader picks
 * 100 rows, leaving no way back to a shorter page.
 */
export function ListPager({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  busy,
}: ListPagerProps) {
  if (total <= PAGE_SIZE_OPTIONS[0]) return null;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-4 border-t pt-4 text-sm"
    >
      <div className="flex items-center gap-4">
        <p className="text-muted-foreground tabular-nums">
          {first}–{last} of {total}
        </p>
        <div className="flex items-center gap-2">
          <span id="rows-per-page" className="text-muted-foreground">
            Rows per page
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger size="sm" aria-labelledby="rows-per-page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground tabular-nums">
          Page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft aria-hidden />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
