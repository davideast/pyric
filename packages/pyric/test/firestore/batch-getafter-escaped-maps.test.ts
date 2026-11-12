import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  Timestamp,
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

describe('Firestore atomic batch getAfter() serverTimestamp() vs literal user maps', () => {
  const RULES = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /docs/a {',
    '      allow get: if request.auth != null',
    '        && resource.data.ts is timestamp',
    '        && resource.data.payload is map',
    "        && resource.data.payload['__type'] == 'serverTimestamp'",
    '        && resource.data.floatMap is map',
    "        && resource.data.floatMap['__type'] == 'float'",
    '        && resource.data.floatMap.value is float',
    '        && resource.data.floatMap.value == 1.5;',
    '      allow create, update: if request.auth != null',
    '        && request.resource.data.ts == request.time',
    '        && request.resource.data.payload is map',
    "        && request.resource.data.payload['__type'] == 'serverTimestamp'",
    '        && request.resource.data.floatMap is map',
    "        && request.resource.data.floatMap['__type'] == 'float'",
    '        && request.resource.data.floatMap.value is float',
    '        && request.resource.data.floatMap.value == 1.5;',
    '    }',
    '    match /docs/b {',
    '      allow create, update: if request.auth != null',
    '        && getAfter(/databases/$(database)/documents/docs/a).data.ts == request.time',
    '        && getAfter(/databases/$(database)/documents/docs/a).data.payload is map',
    "        && getAfter(/databases/$(database)/documents/docs/a).data.payload['__type'] == 'serverTimestamp'",
    '        && getAfter(/databases/$(database)/documents/docs/a).data.floatMap is map',
    "        && getAfter(/databases/$(database)/documents/docs/a).data.floatMap['__type'] == 'float'",
    '        && getAfter(/databases/$(database)/documents/docs/a).data.floatMap.value is float',
    '        && getAfter(/databases/$(database)/documents/docs/a).data.floatMap.value == 1.5;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('resolves serverTimestamp() sentinels to request.time while preserving literal { __type } user maps in writeBatch and runTransaction', async () => {
    for (const mode of ['writeBatch', 'runTransaction'] as const) {
      const sb = initializeSandbox();
      getClock(sb).set(1_700_000_000_000);
      setRules(sb, RULES);
      const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

      if (mode === 'writeBatch') {
        const b = writeBatch(db);
        b.set(doc(db, 'docs', 'a'), {
          ts: serverTimestamp(),
          payload: { __type: 'serverTimestamp' },
          floatMap: { __type: 'float', value: 1.5 },
        });
        b.set(doc(db, 'docs', 'b'), { ok: true });
        await b.commit();
      } else {
        await runTransaction(db, async (tx) => {
          tx.set(doc(db, 'docs', 'a'), {
            ts: serverTimestamp(),
            payload: { __type: 'serverTimestamp' },
            floatMap: { __type: 'float', value: 1.5 },
          });
          tx.set(doc(db, 'docs', 'b'), { ok: true });
        });
      }

      const snapA = await getDoc(doc(db, 'docs', 'a'));
      expect(snapA.exists()).toBe(true);
      const dataA = snapA.data()!;
      expect(dataA.ts).toBeInstanceOf(Timestamp);
      expect(dataA.payload).toEqual({ __type: 'serverTimestamp' });
      expect(dataA.floatMap).toEqual({ __type: 'float', value: 1.5 });
    }
  });

  it('preserves literal { __type } user maps across merge and update operations in writeBatch', async () => {
    const sb = initializeSandbox();
    getClock(sb).set(1_700_000_000_000);
    setRules(sb, RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const b1 = writeBatch(db);
    b1.set(
      doc(db, 'docs', 'a'),
      {
        ts: serverTimestamp(),
        payload: { __type: 'serverTimestamp' },
        floatMap: { __type: 'float', value: 1.5 },
      },
      { merge: true },
    );
    b1.set(doc(db, 'docs', 'b'), { ok: true });
    await b1.commit();

    const b2 = writeBatch(db);
    b2.update(doc(db, 'docs', 'a'), {
      ts: serverTimestamp(),
      payload: { __type: 'serverTimestamp' },
    });
    b2.set(doc(db, 'docs', 'b'), { ok: true });
    await b2.commit();

    const snapA = await getDoc(doc(db, 'docs', 'a'));
    expect(snapA.data()?.payload).toEqual({ __type: 'serverTimestamp' });
    expect(snapA.data()?.floatMap).toEqual({ __type: 'float', value: 1.5 });
  });
});
