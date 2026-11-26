import { afterEach, describe, expect, it } from 'bun:test';
import { initializeApp as initializeUpstreamApp, deleteApp as deleteUpstreamApp } from 'firebase/app';
import {
  FieldValue as UpstreamFieldValue,
  arrayUnion as upstreamArrayUnion,
  collection as upstreamCollection,
  doc as upstreamDoc,
  getFirestore as getUpstreamFirestore,
  increment as upstreamIncrement,
  maximum as upstreamMaximum,
  minimum as upstreamMinimum,
  query as upstreamQuery,
  where as upstreamWhere,
  writeBatch as upstreamWriteBatch,
} from 'firebase/firestore';
import { FirebaseError } from '../../src/app/index.ts';
import {
  Bytes,
  FieldPath,
  FieldValue,
  GeoPoint,
  Timestamp,
  arrayRemove,
  arrayUnion,
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromCache,
  getFirestore,
  increment,
  maximum,
  minimum,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  createFirestoreDataTools,
} from '../../src/firestore/index.ts';
import { initializeSandbox, type LocalSandbox } from '../../src/sandbox/index.ts';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { setRules } from 'pyric/sandbox/firestore';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

let activeSandboxes: LocalSandbox[] = [];

function openTestEnv(rules: string = OPEN_RULES): { sandbox: LocalSandbox; app: LocalSandbox } {
  const sandbox = initializeSandbox();
  setRules(sandbox, rules);
  activeSandboxes.push(sandbox);
  return { sandbox, app: sandbox };
}

afterEach(() => {
  for (const sandbox of activeSandboxes.splice(0)) {
    sandbox.dispose();
  }
});

describe('Firestore maximum(n) and minimum(n) FieldValue sentinels (#1672)', () => {
  it('matches upstream FieldValue inheritance, _methodName, and structural isEqual', async () => {
    expect(maximum(5) instanceof FieldValue).toBe(true);
    expect(minimum(5) instanceof FieldValue).toBe(true);
    expect(FieldValue.maximum(5) instanceof FieldValue).toBe(true);
    expect(FieldValue.minimum(5) instanceof FieldValue).toBe(true);
    expect(maximum(5)._methodName).toBe('maximum');
    expect(minimum(5)._methodName).toBe('minimum');
    expect(maximum(5).isEqual(FieldValue.maximum(5))).toBe(true);
    expect(minimum(5).isEqual(FieldValue.minimum(5))).toBe(true);

    const pairs: Array<[FieldValue, FieldValue, UpstreamFieldValue, UpstreamFieldValue]> = [
      [maximum(10), maximum(10), upstreamMaximum(10), upstreamMaximum(10)],
      [maximum(10), maximum(11), upstreamMaximum(10), upstreamMaximum(11)],
      [maximum(-0), maximum(0), upstreamMaximum(-0), upstreamMaximum(0)],
      [maximum(Number.NaN), maximum(Number.NaN), upstreamMaximum(Number.NaN), upstreamMaximum(Number.NaN)],
      [minimum(3), minimum(3), upstreamMinimum(3), upstreamMinimum(3)],
      [minimum(-0), minimum(0), upstreamMinimum(-0), upstreamMinimum(0)],
      [minimum(Number.NaN), minimum(Number.NaN), upstreamMinimum(Number.NaN), upstreamMinimum(Number.NaN)],
      [maximum(5), minimum(5), upstreamMaximum(5), upstreamMinimum(5)],
      [maximum(5), increment(5), upstreamMaximum(5), upstreamIncrement(5)],
      [minimum(5), increment(5), upstreamMinimum(5), upstreamIncrement(5)],
    ];
    for (const [pyricLeft, pyricRight, upLeft, upRight] of pairs) {
      expect(pyricLeft.isEqual(pyricRight)).toBe(upLeft.isEqual(upRight));
    }
  });

  it('clamps numeric fields across setDoc, merge, mergeFields, updateDoc, writeBatch, and runTransaction', async () => {
    const { app } = openTestEnv();
    const db = getFirestore(app);
    const ref = doc(db, 'metrics/doc-1');

    // Create on absent document overwrites missing fields with operand.
    await setDoc(ref, { high: maximum(10), low: minimum(10), label: 'v1' });
    expect((await getDoc(ref)).data()).toEqual({ high: 10, low: 10, label: 'v1' });

    // updateDoc object form: larger maximum advances, smaller maximum keeps prior; vice versa for minimum.
    await updateDoc(ref, { high: maximum(7), low: minimum(7) });
    expect((await getDoc(ref)).data()).toEqual({ high: 10, low: 7, label: 'v1' });

    await updateDoc(ref, { high: maximum(25), low: minimum(12) });
    expect((await getDoc(ref)).data()).toEqual({ high: 25, low: 7, label: 'v1' });

    // updateDoc FieldPath alternating form on nested fields.
    await updateDoc(ref, new FieldPath('nested', 'maxVal'), maximum(-4), 'nested.minVal', minimum(-4));
    await updateDoc(ref, new FieldPath('nested', 'maxVal'), maximum(-1), 'nested.minVal', minimum(-9));
    expect((await getDoc(ref)).data()).toEqual({
      high: 25,
      low: 7,
      label: 'v1',
      nested: { maxVal: -1, minVal: -9 },
    });

    // setDoc with { merge: true } preserves unmentioned fields and clamps against existing prior.
    await setDoc(ref, { high: maximum(100), low: minimum(2) }, { merge: true });
    expect((await getDoc(ref)).data()).toEqual({
      high: 100,
      low: 2,
      label: 'v1',
      nested: { maxVal: -1, minVal: -9 },
    });

    // setDoc with { mergeFields } applies only the masked transform.
    await setDoc(ref, { high: maximum(500), low: minimum(-50) }, { mergeFields: ['high'] });
    expect((await getDoc(ref)).data()).toEqual({
      high: 500,
      low: 2,
      label: 'v1',
      nested: { maxVal: -1, minVal: -9 },
    });

    // Plain setDoc WITHOUT merge wipes unmentioned fields while evaluating fieldTransforms against the existing doc (SetMutation semantics).
    await setDoc(ref, { high: maximum(600), low: minimum(50) });
    expect((await getDoc(ref)).data()).toEqual({ high: 600, low: 2 });

    // writeBatch atomic transforms.
    const batch = writeBatch(db);
    batch.update(ref, { high: maximum(642), low: minimum(1) });
    await batch.commit();
    expect((await getDoc(ref)).data()).toEqual({ high: 642, low: 1 });

    // runTransaction read + conditional clamp.
    await runTransaction(db, async (txn) => {
      const current = await txn.get(ref);
      const data = current.data();
      expect(data).toEqual({ high: 642, low: 1 });
      txn.update(ref, { high: maximum(40), low: minimum(-5) });
    });
    expect((await getDoc(ref)).data()).toEqual({ high: 642, low: -5 });
  });

  it('overwrites missing and non-numeric priors with the operand', async () => {
    const { app } = openTestEnv();
    const db = getFirestore(app);
    const ref = doc(db, 'mismatch/doc-1');

    const nonNumericPriors: Record<string, unknown> = {
      nullVal: null,
      strVal: '999',
      boolVal: true,
      arrVal: [1, 2, 3],
      mapVal: { nested: 100 },
      tsVal: Timestamp.fromMillis(1_700_000_000_000),
      bytesVal: Bytes.fromUint8Array(new Uint8Array([1, 2])),
      geoVal: new GeoPoint(10, 20),
    };

    await setDoc(ref, nonNumericPriors);
    await updateDoc(ref, {
      missingMax: maximum(-5),
      missingMin: minimum(5),
      nullVal: maximum(8),
      strVal: minimum(4),
      boolVal: maximum(0),
      arrVal: minimum(-2),
      mapVal: maximum(3.5),
      tsVal: minimum(1.25),
      bytesVal: maximum(-100),
      geoVal: minimum(100),
    });

    expect((await getDoc(ref)).data()).toEqual({
      missingMax: -5,
      missingMin: 5,
      nullVal: 8,
      strVal: 4,
      boolVal: 0,
      arrVal: -2,
      mapVal: 3.5,
      tsVal: 1.25,
      bytesVal: -100,
      geoVal: 100,
    });
  });

  it('preserves NaN, infinities, -0 vs +0 tie identity, and int64 bigint tie/comparison semantics', async () => {
    const { sandbox, app } = openTestEnv();
    const db = getFirestore(app);
    const nanRef = doc(db, 'special/nan');

    // NaN operand yields NaN over numeric prior.
    await setDoc(nanRef, { a: 10, b: 10, c: Number.NaN, d: Number.NaN });
    await updateDoc(nanRef, {
      a: maximum(Number.NaN),
      b: minimum(Number.NaN),
      c: maximum(100),
      d: minimum(-100),
    });
    const nanData = (await getDoc(nanRef)).data() as Record<string, unknown>;
    expect(Number.isNaN(nanData.a)).toBe(true);
    expect(Number.isNaN(nanData.b)).toBe(true);
    expect(Number.isNaN(nanData.c)).toBe(true);
    expect(Number.isNaN(nanData.d)).toBe(true);

    // Infinities clamp naturally.
    const infRef = doc(db, 'special/inf');
    await setDoc(infRef, { hi: 100, lo: -100 });
    await updateDoc(infRef, {
      hi: maximum(Number.POSITIVE_INFINITY),
      lo: minimum(Number.NEGATIVE_INFINITY),
    });
    expect((await getDoc(infRef)).data()).toEqual({
      hi: Number.POSITIVE_INFINITY,
      lo: Number.NEGATIVE_INFINITY,
    });

    // -0 vs +0 tie preserves the prior value unchanged.
    const zeroRef = doc(db, 'special/zero');
    await setDoc(zeroRef, { negMax: -0, posMax: 0, negMin: -0, posMin: 0 });
    await updateDoc(zeroRef, {
      negMax: maximum(0),
      posMax: maximum(-0),
      negMin: minimum(0),
      posMin: minimum(-0),
    });
    const zeroData = (await getDoc(zeroRef)).data() as Record<string, number>;
    expect(Object.is(zeroData.negMax, -0)).toBe(true);
    expect(Object.is(zeroData.posMax, 0)).toBe(true);
    expect(Object.is(zeroData.negMin, -0)).toBe(true);
    expect(Object.is(zeroData.posMin, 0)).toBe(true);

    // Exact int64 bigint seeded via admin handle compares accurately against float operands.
    const adminDb = getAdminFirestore(sandbox);
    const bigPrior = 9007199254740993n; // 2^53 + 1
    await adminDb.doc('special/int64').set({
      keepBigMax: bigPrior,
      beatBigMax: bigPrior,
      keepBigMin: -bigPrior,
      beatBigMin: -bigPrior,
    });
    await updateDoc(doc(db, 'special/int64'), {
      keepBigMax: maximum(9007199254740992), // 2^53 < 2^53 + 1 -> keeps bigPrior
      beatBigMax: maximum(1e20), // 1e20 > 2^53 + 1 -> updates to 1e20
      keepBigMin: minimum(-9007199254740992), // -2^53 > -(2^53 + 1) -> keeps -bigPrior
      beatBigMin: minimum(-1e20), // -1e20 < -(2^53 + 1) -> updates to -1e20
    });
    const adminAfter = (await adminDb.doc('special/int64').get()).data() as Record<string, unknown>;
    expect(adminAfter.keepBigMax).toBe(bigPrior);
    expect(adminAfter.beatBigMax).toBe(1e20);
    expect(adminAfter.keepBigMin).toBe(-bigPrior);
    expect(adminAfter.beatBigMin).toBe(-1e20);
  });

  it('exposes post-transform values on request.resource.data in Security Rules and works offline + via data tools', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /guarded/{id} {
      allow read: if true;
      allow create, update: if request.resource.data.high <= 50 && request.resource.data.low >= 0;
    }
  }
}`;
    const { sandbox, app } = openTestEnv(rules);
    const db = getFirestore(app);
    const ref = doc(db, 'guarded/d1');

    await setDoc(ref, { high: 20, low: 10 });
    await updateDoc(ref, { high: maximum(50), low: minimum(5) });
    expect((await getDoc(ref)).data()).toEqual({ high: 50, low: 5 });

    // Exceeding rule cap via maximum(51) or minimum(-1) is denied by Security Rules!
    await expect(updateDoc(ref, { high: maximum(51) })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateDoc(ref, { low: minimum(-1) })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await getDoc(ref)).data()).toEqual({ high: 50, low: 5 });

    // Offline write staging & snapshot visibility.
    const seen: Array<Record<string, unknown> | undefined> = [];
    const unsub = onSnapshot(ref, (snap) => {
      seen.push(snap.data());
    });
    try {
      await disableNetwork(db);
      const pending = updateDoc(ref, { high: maximum(45), low: minimum(2) });
      const cached = await getDocFromCache(ref);
      expect(cached.data()).toEqual({ high: 50, low: 2 });
      await enableNetwork(db);
      await pending;
      expect((await getDoc(ref)).data()).toEqual({ high: 50, low: 2 });
      expect(seen[seen.length - 1]).toEqual({ high: 50, low: 2 });
    } finally {
      unsub();
    }

    // Firestore data tools rehydration for maximum/minimum sentinel descriptors.
    await setDoc(doc(db, 'guarded/d2'), { high: 10, low: 10 });
    const tools = createFirestoreDataTools({ resolveDb: async () => db });
    const updateTool = tools.find((tool) => tool.name === 'firestore_update_document');
    expect(updateTool).toBeDefined();
    if (updateTool !== undefined) {
      await updateTool.execute({
        path: 'guarded/d2',
        data: {
          high: { __type: 'maximum', value: 48 },
          low: { __type: 'minimum', value: 1 },
        },
      });
    }
    expect((await getDoc(doc(db, 'guarded/d2'))).data()).toEqual({ high: 48, low: 1 });
  });

  it('rejects invalid placements and non-numeric operands with invalid-argument matching upstream', async () => {
    const { app } = openTestEnv();
    const db = getFirestore(app);
    const ref = doc(db, 'invalid/doc-1');

    const upApp = initializeUpstreamApp({ projectId: 'demo-upstream' }, `up-${Date.now()}`);
    try {
      const upDb = getUpstreamFirestore(upApp);
      const upRef = upstreamDoc(upDb, 'invalid/doc-1');

      const assertSameErrorCode = (pyricFn: () => unknown, upstreamFn: () => unknown): void => {
        let pyricCode: string | undefined;
        let upstreamCode: string | undefined;
        try {
          pyricFn();
        } catch (err) {
          if (err instanceof FirebaseError) pyricCode = err.code;
        }
        try {
          upstreamFn();
        } catch (err) {
          if (err !== null && typeof err === 'object' && 'code' in err) {
            upstreamCode = String((err as { code: unknown }).code);
          }
        }
        expect(pyricCode).toBe('invalid-argument');
        expect(upstreamCode).toBe('invalid-argument');
      };

      assertSameErrorCode(
        () => writeBatch(db).set(ref, { arr: [maximum(5)] }),
        () => upstreamWriteBatch(upDb).set(upRef, { arr: [upstreamMaximum(5)] }),
      );
      assertSameErrorCode(
        () => writeBatch(db).update(ref, { arr: [minimum(5)] }),
        () => upstreamWriteBatch(upDb).update(upRef, { arr: [upstreamMinimum(5)] }),
      );
      assertSameErrorCode(
        () => writeBatch(db).set(ref, { arr: arrayUnion(maximum(5)) }),
        () => upstreamWriteBatch(upDb).set(upRef, { arr: upstreamArrayUnion(upstreamMaximum(5)) }),
      );
      assertSameErrorCode(
        () => query(collection(db, 'invalid'), where('x', '==', maximum(5))),
        () => upstreamQuery(upstreamCollection(upDb, 'invalid'), upstreamWhere('x', '==', upstreamMaximum(5))),
      );

      await expect(setDoc(ref, { arr: arrayRemove(minimum(3)) })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      await expect(setDoc(ref, { x: maximum(undefined as unknown as number) })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      await expect(setDoc(ref, { x: minimum('bad' as unknown as number) })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      expect(() => updateDoc(ref, { x: maximum('bad' as unknown as number) })).toThrow(FirebaseError);
    } finally {
      await deleteUpstreamApp(upApp);
    }
  });
});
