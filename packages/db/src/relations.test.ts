import { describe, expect, it } from 'vitest';
import { liveOne, liveOneOrThrow, MissingLiveRowError, MultipleLiveRowsError } from './relations';

describe('liveOne', () => {
  it('returns null when the relation is empty', () => {
    expect(liveOne([], 'liquidation')).toBeNull();
  });

  it('returns the single row', () => {
    expect(liveOne([{ id: 'a' }], 'liquidation')).toEqual({ id: 'a' });
  });

  it('throws when more than one live row survives the soft-delete filter', () => {
    // Two live rows means the partial unique index is gone. Returning the
    // first would quietly pick a winner and let a shipment carry two
    // liquidations.
    expect(() => liveOne([{ id: 'a' }, { id: 'b' }], 'liquidation')).toThrow(MultipleLiveRowsError);
  });

  it('names the relation and the count in the error', () => {
    expect(() => liveOne([1, 2, 3], 'profile')).toThrow(/at most one live profile, found 3/);
  });
});

describe('liveOneOrThrow', () => {
  it('returns the single row', () => {
    expect(liveOneOrThrow([{ id: 'a' }], 'profile')).toEqual({ id: 'a' });
  });

  it('throws when the relation is empty', () => {
    expect(() => liveOneOrThrow([], 'profile')).toThrow(MissingLiveRowError);
  });

  it('still throws when there is more than one', () => {
    expect(() => liveOneOrThrow([1, 2], 'profile')).toThrow(MultipleLiveRowsError);
  });
});
