import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import {
  FirestoreError,
  average,
  collection,
  count,
  doc,
  getAggregateFromServer,
  getFirestore,
  setDoc,
  sum,
} from 'pyric/firestore';

describe('getAggregateFromServer aggregation count bounds (#1971)', () => {
  it('refuses 0 aggregations and more than 5 aggregations with FirebaseError(invalid-argument), while allowing 1 to 5', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'metrics/m1'), { score: 10 });
    await setDoc(doc(db, 'metrics/m2'), { score: 20 });
    const metrics = collection(db, 'metrics');

    let zeroError: unknown;
    try {
      await getAggregateFromServer(metrics, {});
    } catch (error) {
      zeroError = error;
    }
    expect(zeroError).toBeInstanceOf(FirebaseError);
    expect(zeroError).not.toBeInstanceOf(FirestoreError);
    expect((zeroError as FirebaseError).code).toBe('invalid-argument');

    const oneSnap = await getAggregateFromServer(metrics, { totalCount: count() });
    expect(oneSnap.data()).toEqual({ totalCount: 2 });

    const fiveSnap = await getAggregateFromServer(metrics, {
      a1: count(),
      a2: sum('score'),
      a3: average('score'),
      a4: count(),
      a5: sum('score'),
    });
    expect(fiveSnap.data()).toEqual({
      a1: 2,
      a2: 30,
      a3: 15,
      a4: 2,
      a5: 30,
    });

    let sixError: unknown;
    try {
      await getAggregateFromServer(metrics, {
        a1: count(),
        a2: count(),
        a3: count(),
        a4: count(),
        a5: count(),
        a6: count(),
      });
    } catch (error) {
      sixError = error;
    }
    expect(sixError).toBeInstanceOf(FirebaseError);
    expect(sixError).not.toBeInstanceOf(FirestoreError);
    expect((sixError as FirebaseError).code).toBe('invalid-argument');
  });
});
