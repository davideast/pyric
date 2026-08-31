/**
 * RTDB modular SDK — constraint-conflict probes (T4-3 / DB-B5).
 *
 * Prod throws synchronously when a query combines conflicting
 * constraints. The sandbox silently last-won. Confirmed against the
 * upstream clone `api/Reference_impl.ts`:
 *   - multiple orderBy → :160-165
 *   - double limit → :1945-1951
 *   - equalTo + range / double start|end → :1824-1841, 1888-1905,
 *     2193-2206
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  query,
  orderByChild,
  orderByKey,
  startAt,
  endAt,
  equalTo,
  limitToFirst,
  limitToLast,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('DB-B5 — constraint-conflict validation', () => {
  it('multiple orderBy calls throw', () => {
    const { db } = setup();
    expect(() =>
      query(ref(db, 'col'), orderByChild('a'), orderByKey()),
    ).toThrow(/combine multiple orderBy/);
  });

  it('double limit throws', () => {
    const { db } = setup();
    expect(() =>
      query(ref(db, 'col'), limitToFirst(2), limitToLast(3)),
    ).toThrow(/Limit was already set/);
  });

  it('equalTo after a range start throws', () => {
    const { db } = setup();
    expect(() =>
      query(ref(db, 'col'), orderByChild('a'), startAt(1), equalTo(2)),
    ).toThrow(/Starting point was already set/);
  });

  it('a second startAt throws', () => {
    const { db } = setup();
    expect(() =>
      query(ref(db, 'col'), orderByChild('a'), startAt(1), startAt(2)),
    ).toThrow(/Starting point was already set/);
  });

  it('endAt after equalTo throws (equalTo set the end)', () => {
    const { db } = setup();
    expect(() =>
      query(ref(db, 'col'), orderByChild('a'), equalTo(2), endAt(5)),
    ).toThrow(/Ending point was already set/);
  });
});
