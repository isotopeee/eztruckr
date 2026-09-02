import { SHIPMENT_STATUS_SEQUENCE, SHIPMENT_STATUS_LABELS } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';

/**
 * The one assumption the shipment list's status ordering rests on.
 *
 * `ShipmentsService.orderFor` sorts the Status column with a plain
 * `orderBy: { status: direction }` — the numeric code — which the code set is
 * explicit that nothing may do: workflow order comes from
 * SHIPMENT_STATUS_SEQUENCE, because a status appended later could belong early
 * in the workflow and still carry the highest number.
 *
 * It is done anyway because Prisma cannot order by position in a list without
 * the query dropping to raw SQL, and today the codes happen to ascend with the
 * sequence. This test is what stops that coincidence expiring silently: append
 * a mid-workflow status and it fails here, at which point the list needs a
 * CASE mapping rather than a column name.
 *
 * A pure check on the code set — no database, nothing to stand up.
 */
describe('the shipment list may sort Status by its numeric code', () => {
  it('only because the codes ascend in workflow order', () => {
    const byCode = [...SHIPMENT_STATUS_SEQUENCE].sort((left, right) => left - right);

    expect(
      byCode.map((status) => SHIPMENT_STATUS_LABELS[status]),
      'a status now sits out of workflow order by code — the list needs an explicit rank',
    ).toEqual(SHIPMENT_STATUS_SEQUENCE.map((status) => SHIPMENT_STATUS_LABELS[status]));
  });
});
