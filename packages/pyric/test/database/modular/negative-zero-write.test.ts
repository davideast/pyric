/**
 * RTDB modular SDK: a `-0` write is the stored `0` (#2160).
 *
 * Production RTDB values travel as JSON, where `-0` serializes as `0`, so a
 * `set` of `-0` over a stored `0` leaves the value unchanged: no listener
 * event fires, and a read returns `0`.
 */
import { describe, expect, it } from 'bun:test';
import { get, onChildChanged, onValue, ref, set } from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('a -0 write over a stored 0', () => {
  it('fires no child_changed and no second value event', async () => {
    const { db } = setup();
    await set(ref(db, 'scores/alice'), 0);
    const values: unknown[] = [];
    const changed: unknown[] = [];
    const offValue = onValue(ref(db, 'scores/alice'), (snap) => values.push(snap.val()));
    const offChanged = onChildChanged(ref(db, 'scores'), (snap) => changed.push(snap.key));

    await set(ref(db, 'scores/alice'), -0);
    await set(ref(db, 'scores'), { alice: -0 });

    expect(values).toHaveLength(1);
    expect(changed).toEqual([]);
    offValue();
    offChanged();
  });

  it('stores 0, as production does', async () => {
    const { db } = setup();
    await set(ref(db, 'scores/alice'), -0);
    expect(Object.is((await get(ref(db, 'scores/alice'))).val(), 0)).toBe(true);
  });
});
