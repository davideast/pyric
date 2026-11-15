import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  VectorValue,
  arrayRemove,
  arrayUnion,
  deleteField,
  doc,
  getDoc,
  getFirestore,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  vector,
  writeBatch,
} from 'pyric/firestore';

const TYPED_ARRAY_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} {',
  '      allow read: if true;',
  '      allow write: if',
  '        request.resource.data.dates[0] is timestamp &&',
  '        request.resource.data.refs[0] is path &&',
  '        request.resource.data.geos[0] is latlng &&',
  '        request.resource.data.blobs[0] is bytes &&',
  '        request.resource.data.nested[0].at is timestamp &&',
  '        request.resource.data.nested[0].ref is path &&',
  '        request.resource.data.nested[0].loc is latlng &&',
  '        request.resource.data.nested[0].raw is bytes &&',
  '        request.resource.data.matrix[0][0] is timestamp;',
  '    }',
  '  }',
  '}',
].join('\n');

const ALLOW_ALL_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

function buildNestedMap(depth: number, leaf: unknown): Record<string, unknown> {
  let current: unknown = leaf;
  for (let i = 0; i < depth; i += 1) {
    current = { next: current };
  }
  return current as Record<string, unknown>;
}

describe('Firestore arrayUnion and arrayRemove typed element resolution', () => {
  test('arrayUnion resolves Date, DocumentReference, GeoPoint, Bytes, VectorValue, and nested containers for rules and reads', async () => {
    const sb = initializeSandbox();
    setRules(sb, TYPED_ARRAY_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    const targetRef = doc(db, 'users', 'u1');
    const geo = new GeoPoint(37.7749, -122.4194);
    const bytes = Bytes.fromUint8Array(new Uint8Array([1, 2, 3, 4]));
    const vec = vector([0.25, 0.75]);
    const itemRef = doc(db, 'items', 'd1');

    await setDoc(itemRef, {
      dates: arrayUnion(t0),
      refs: arrayUnion(targetRef),
      geos: arrayUnion(geo),
      blobs: arrayUnion(bytes),
      vectors: arrayUnion(vec),
      nested: arrayUnion({ at: t0, ref: targetRef, loc: geo, raw: bytes, vec }),
      matrix: arrayUnion([t1, targetRef]),
    });

    const snap = await getDoc(itemRef);
    const data = snap.data();
    expect(data).toBeDefined();
    if (data === undefined) return;

    const dates = data.dates as Timestamp[];
    expect(dates).toHaveLength(1);
    expect(dates[0]).toBeInstanceOf(Timestamp);
    expect(dates[0]?.toMillis()).toBe(t0.getTime());

    const refs = data.refs as Array<{ path: string }>;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe('users/u1');

    const geos = data.geos as GeoPoint[];
    expect(geos).toHaveLength(1);
    expect(geos[0]).toBeInstanceOf(GeoPoint);
    expect(geos[0]?.latitude).toBe(37.7749);
    expect(geos[0]?.longitude).toBe(-122.4194);

    const blobs = data.blobs as Bytes[];
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toBeInstanceOf(Bytes);
    expect(Array.from(blobs[0]?.toUint8Array() ?? [])).toEqual([1, 2, 3, 4]);

    const vectors = data.vectors as VectorValue[];
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeInstanceOf(VectorValue);
    expect(vectors[0]?.toArray()).toEqual([0.25, 0.75]);

    const nested = data.nested as Array<Record<string, unknown>>;
    expect(nested).toHaveLength(1);
    expect(nested[0]?.at).toBeInstanceOf(Timestamp);
    expect((nested[0]?.ref as { path?: string })?.path).toBe('users/u1');
    expect(nested[0]?.loc).toBeInstanceOf(GeoPoint);
    expect(nested[0]?.raw).toBeInstanceOf(Bytes);
    expect(nested[0]?.vec).toBeInstanceOf(VectorValue);

    const matrix = data.matrix as unknown[][];
    expect(matrix).toHaveLength(1);
    expect(matrix[0]?.[0]).toBeInstanceOf(Timestamp);
    expect((matrix[0]?.[1] as { path?: string })?.path).toBe('users/u1');
  });

  test('arrayUnion deduplicates equivalent typed elements across writes and within a single call', async () => {
    const sb = initializeSandbox();
    setRules(sb, ALLOW_ALL_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const t0 = new Date('2026-03-10T12:00:00.000Z');
    const preciseTs = new Timestamp(100, 123_456_789);
    const truncatedTs = new Timestamp(100, 123_456_000);
    const refA = doc(db, 'users', 'u1');
    const refAClone = doc(db, 'users', 'u1');
    const geoA = new GeoPoint(10, 20);
    const bytesA = Bytes.fromUint8Array(new Uint8Array([9, 8]));
    const vecA = vector([1, 2]);
    const itemRef = doc(db, 'items', 'dedup');

    await setDoc(itemRef, {
      dates: [t0],
      precise: [preciseTs],
      refs: [refA],
      geos: [geoA],
      blobs: [bytesA],
      vectors: [vecA],
      nested: [{ ref: refA, at: t0, loc: geoA, raw: bytesA }],
    });

    await updateDoc(itemRef, {
      dates: arrayUnion(new Date(t0.getTime()), Timestamp.fromMillis(t0.getTime())),
      precise: arrayUnion(truncatedTs, new Timestamp(100, 123_456_999)),
      refs: arrayUnion(refAClone),
      geos: arrayUnion(new GeoPoint(10, 20)),
      blobs: arrayUnion(Bytes.fromUint8Array(new Uint8Array([9, 8]))),
      vectors: arrayUnion(vector([1, 2])),
      nested: arrayUnion({
        raw: Bytes.fromUint8Array(new Uint8Array([9, 8])),
        loc: new GeoPoint(10, 20),
        at: Timestamp.fromMillis(t0.getTime()),
        ref: doc(db, 'users', 'u1'),
      }),
    });

    const data = (await getDoc(itemRef)).data();
    expect(data).toBeDefined();
    if (data === undefined) return;
    expect(data.dates).toHaveLength(1);
    expect(data.precise).toHaveLength(1);
    expect(data.refs).toHaveLength(1);
    expect(data.geos).toHaveLength(1);
    expect(data.blobs).toHaveLength(1);
    expect(data.vectors).toHaveLength(1);
    expect(data.nested).toHaveLength(1);
  });

  test('arrayRemove removes typed elements and nested containers across updateDoc, merge setDoc, writeBatch, and runTransaction', async () => {
    const sb = initializeSandbox();
    setRules(sb, ALLOW_ALL_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const t0 = new Date('2026-04-01T00:00:00.000Z');
    const t1 = new Date('2026-04-02T00:00:00.000Z');
    const ref0 = doc(db, 'users', 'u0');
    const ref1 = doc(db, 'users', 'u1');
    const geo0 = new GeoPoint(1, 2);
    const geo1 = new GeoPoint(3, 4);
    const bytes0 = Bytes.fromUint8Array(new Uint8Array([1, 1]));
    const bytes1 = Bytes.fromUint8Array(new Uint8Array([2, 2]));
    const vec0 = vector([1, 0]);
    const vec1 = vector([0, 1]);
    const itemRef = doc(db, 'items', 'remove');

    await setDoc(itemRef, {
      dates: [t0, t1],
      refs: [ref0, ref1],
      geos: [geo0, geo1],
      blobs: [bytes0, bytes1],
      vectors: [vec0, vec1],
      nested: [{ at: t0, ref: ref0 }, { at: t1, ref: ref1 }],
      matrix: [[t0], [t1]],
    });

    await updateDoc(itemRef, {
      dates: arrayRemove(new Date(t0.getTime())),
      refs: arrayRemove(doc(db, 'users', 'u0')),
    });

    await setDoc(
      itemRef,
      {
        geos: arrayRemove(new GeoPoint(1, 2)),
        blobs: arrayRemove(Bytes.fromUint8Array(new Uint8Array([1, 1]))),
      },
      { merge: true },
    );

    const batch = writeBatch(db);
    batch.update(itemRef, {
      vectors: arrayRemove(vector([1, 0])),
      nested: arrayRemove({ ref: doc(db, 'users', 'u0'), at: Timestamp.fromMillis(t0.getTime()) }),
    });
    await batch.commit();

    await runTransaction(db, async (tx) => {
      await tx.get(itemRef);
      tx.update(itemRef, {
        matrix: arrayRemove([new Date(t0.getTime())]),
      });
    });

    const data = (await getDoc(itemRef)).data();
    expect(data).toBeDefined();
    if (data === undefined) return;
    expect((data.dates as Timestamp[]).map((d) => d.toMillis())).toEqual([t1.getTime()]);
    expect((data.refs as Array<{ path: string }>).map((r) => r.path)).toEqual(['users/u1']);
    expect((data.geos as GeoPoint[]).map((g) => [g.latitude, g.longitude])).toEqual([[3, 4]]);
    expect((data.blobs as Bytes[]).map((b) => Array.from(b.toUint8Array()))).toEqual([[2, 2]]);
    expect((data.vectors as VectorValue[]).map((v) => v.toArray())).toEqual([[0, 1]]);
    expect(data.nested).toHaveLength(1);
    expect(((data.nested as Array<{ ref: { path: string } }>)[0])?.ref.path).toBe('users/u1');
    expect(data.matrix).toHaveLength(1);
    expect(((data.matrix as Timestamp[][])[0]?.[0])?.toMillis()).toBe(t1.getTime());
  });

  test('rejects nested FieldValue sentinels inside arrayUnion and arrayRemove with invalid-argument', async () => {
    const sb = initializeSandbox();
    setRules(sb, ALLOW_ALL_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const itemRef = doc(db, 'items', 'invalid-sentinels');
    await setDoc(itemRef, { tags: ['seed'] });

    const forbiddenPayloads: Array<{ label: string; value: unknown }> = [
      { label: 'arrayUnion(serverTimestamp())', value: arrayUnion(serverTimestamp()) },
      { label: 'arrayUnion(increment(1))', value: arrayUnion(increment(1)) },
      { label: 'arrayUnion(deleteField())', value: arrayUnion(deleteField()) },
      { label: 'arrayUnion(arrayUnion("x"))', value: arrayUnion(arrayUnion('x')) },
      { label: 'arrayUnion(arrayRemove("x"))', value: arrayUnion(arrayRemove('x')) },
      { label: 'arrayUnion({ nested: serverTimestamp() })', value: arrayUnion({ nested: serverTimestamp() }) },
      { label: 'arrayUnion([increment(2)])', value: arrayUnion([increment(2)]) },
      { label: 'arrayRemove(serverTimestamp())', value: arrayRemove(serverTimestamp()) },
      { label: 'arrayRemove({ nested: deleteField() })', value: arrayRemove({ nested: deleteField() }) },
    ];

    for (const payload of forbiddenPayloads) {
      await expect(
        updateDoc(itemRef, { tags: payload.value }),
        payload.label,
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }

    // Even when prior field is absent or non-array, arrayRemove must still reject nested sentinels.
    await expect(
      updateDoc(itemRef, { missingField: arrayRemove(serverTimestamp()) }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    const batch = writeBatch(db);
    batch.update(itemRef, { tags: arrayUnion({ bad: increment(1) }) });
    await expect(batch.commit()).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('preserves literal user maps with colliding __type keys inside arrayUnion and arrayRemove while rejecting real sentinels inside them', async () => {
    const sb = initializeSandbox();
    setRules(sb, ALLOW_ALL_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const itemRef = doc(db, 'items', 'literal-maps');
    const literalMap = { __type: 'serverTimestamp', label: 'literal' };

    await setDoc(itemRef, {
      entries: arrayUnion(literalMap),
    });
    expect((await getDoc(itemRef)).data()).toEqual({
      entries: [literalMap],
    });

    await updateDoc(itemRef, {
      entries: arrayRemove({ __type: 'serverTimestamp', label: 'literal' }),
    });
    expect((await getDoc(itemRef)).data()).toEqual({
      entries: [],
    });

    await expect(
      updateDoc(itemRef, {
        entries: arrayUnion({ __type: 'serverTimestamp', real: serverTimestamp() }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('applies write limits to arrayUnion elements without counting DocumentReference shells as nested maps', async () => {
    const sb = initializeSandbox();
    setRules(sb, ALLOW_ALL_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const itemRef = doc(db, 'items', 'limits');
    const targetRef = doc(db, 'users', 'u1');

    // A DocumentReference inside a 20-deep map inside arrayUnion must remain allowed.
    const maxDepthWithRef = buildNestedMap(20, targetRef);
    await setDoc(itemRef, {
      refs: arrayUnion(maxDepthWithRef),
    });
    const snap = await getDoc(itemRef);
    expect(snap.data()).toBeDefined();

    // A 21-deep plain map inside arrayUnion exceeds Firestore map depth limits.
    const tooDeepMap = buildNestedMap(21, 'leaf');
    await expect(
      updateDoc(itemRef, { refs: arrayUnion(tooDeepMap) }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
