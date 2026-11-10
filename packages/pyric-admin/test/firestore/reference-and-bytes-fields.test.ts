import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import {
  doc as clientDoc,
  getDoc as clientGetDoc,
  getFirestore as getClientFirestore,
} from 'pyric/firestore';
import { getFirestore as getRuleEnforcedFirestore } from 'pyric/sandbox/admin-firestore';
import { deleteApp, isSandboxAdminApp } from '../../src/app/index.js';
import {
  FieldPath,
  FieldValue,
  getFirestore,
  onSnapshot,
  type DocumentReference,
} from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

const ARMS = [
  ['in-process', inProcessFirestoreArm],
  ['shared-worker', sharedWorkerFirestoreArm],
] as const;

const REFERENCE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null;
    }
    match /docs/{docId} {
      allow read: if request.auth != null
        && resource.data.ownerRef is reference
        && resource.data.ownerRef.id == request.auth.uid
        && resource.data.ownerRef.path == 'users/' + request.auth.uid;
    }
    match /items/{itemId} {
      allow read: if request.auth != null && resource.data.payload is bytes;
    }
  }
}
`;

describe.each(ARMS)('pyric-admin/firestore DocumentReference fields (%s)', (_label, makeArm) => {
  test('stores DocumentReference values as real references, satisfies is-reference security rules, and rehydrates live DocumentReferences on read', async () => {
    const { app, host } = makeArm(REFERENCE_RULES);
    try {
      const db = getFirestore(app);
      await db.doc('users/u1').set({ displayName: 'Alice' });
      await db.doc('users/u2').set({ displayName: 'Bob' });

      const u1Ref = db.doc('users/u1');
      const u2Ref = db.doc('users/u2');

      await db.doc('docs/d1').set({
        ownerRef: u1Ref,
        nested: { reviewerRef: u2Ref },
        watchers: [u1Ref],
      });

      // Rule-enforced client read via modular Web SDK on host sandbox
      const authedClientDb = getClientFirestore(host.withAuth({ uid: 'u1', token: {} }));
      const clientSnap = await clientGetDoc(clientDoc(authedClientDb, 'docs', 'd1'));
      expect(clientSnap.exists()).toBe(true);

      // Rule-enforced read on the same sandbox (in-process or remote)
      if (isSandboxAdminApp(app)) {
        const ruleDb = getRuleEnforcedFirestore(app.sandbox.withAuth({ uid: 'u1', token: {} }));
        const ruleSnap = await ruleDb.doc('docs/d1').get();
        expect(ruleSnap.exists).toBe(true);
      }

      // Direct DocumentSnapshot read-back via data() and get()
      const snap = await db.doc('docs/d1').get();
      const data = snap.data()!;
      const ownerRef = data.ownerRef as DocumentReference;
      expect(ownerRef.id).toBe('u1');
      expect(ownerRef.path).toBe('users/u1');
      expect(ownerRef.parent.id).toBe('users');
      expect(typeof ownerRef.get).toBe('function');

      const ownerDoc = await ownerRef.get();
      expect(ownerDoc.exists).toBe(true);
      expect(ownerDoc.data()).toEqual({ displayName: 'Alice' });

      const reviewerViaGet = snap.get(new FieldPath('nested', 'reviewerRef')) as DocumentReference;
      expect(reviewerViaGet.path).toBe('users/u2');
      expect((await reviewerViaGet.get()).data()).toEqual({ displayName: 'Bob' });

      // Update + arrayUnion with DocumentReference
      await db.doc('docs/d1').update({
        watchers: FieldValue.arrayUnion(u2Ref),
      });
      const updatedWatchers = ((await db.doc('docs/d1').get()).data()!.watchers as DocumentReference[]);
      expect(updatedWatchers.map((r) => r.path)).toEqual(['users/u1', 'users/u2']);

      // Batch + Transaction writes + Query where('ownerRef', '==', ref)
      const batch = db.batch();
      batch.create(db.doc('docs/d2'), { ownerRef: u2Ref });
      await batch.commit();

      await db.runTransaction(async (tx) => {
        const d2 = await tx.get(db.doc('docs/d2'));
        const existingOwner = d2.data()!.ownerRef as DocumentReference;
        expect(existingOwner.path).toBe('users/u2');
        tx.set(db.doc('docs/d3'), { ownerRef: u1Ref });
      });

      const matchingU1 = await db.collection('docs').where('ownerRef', '==', u1Ref).get();
      expect(matchingU1.docs.map((d) => d.id).sort()).toEqual(['d1', 'd3']);
      for (const qDoc of matchingU1.docs) {
        const qOwner = qDoc.data().ownerRef as DocumentReference;
        expect(qOwner.path).toBe('users/u1');
        expect(typeof qOwner.get).toBe('function');
      }

      // Live onSnapshot rehydration + snapshot cursor pagination from both get() and onSnapshot()
      let capturedLiveDocSnap: Parameters<Parameters<typeof onSnapshot>[1]>[0] | undefined;
      const seenPaths: string[] = [];
      const unsub = onSnapshot(db.doc('docs/d1'), (liveSnap) => {
        capturedLiveDocSnap = liveSnap;
        const liveRef = liveSnap.data()?.ownerRef as DocumentReference | undefined;
        if (liveRef) seenPaths.push(liveRef.path);
      });
      await new Promise((r) => setTimeout(r, 25));
      unsub();
      expect(seenPaths).toContain('users/u1');
      expect(capturedLiveDocSnap).toBeDefined();

      // applyFilter with DocumentReference operands
      const filteredRefs = await db
        .collection('docs')
        .applyFilter({
          kind: 'or',
          filters: [
            { kind: 'where', field: 'ownerRef', op: '==', value: u1Ref },
            { kind: 'where', field: 'ownerRef', op: '==', value: u2Ref },
          ],
        })
        .orderBy('ownerRef', 'asc')
        .get();
      expect(filteredRefs.docs.map((d) => d.id)).toEqual(['d1', 'd3', 'd2']);

      // Explicit startCursor / endCursor with DocumentReference operands
      const cursorFromU2 = await db
        .collection('docs')
        .orderBy('ownerRef', 'asc')
        .startCursor([u2Ref], true)
        .get();
      expect(cursorFromU2.docs.map((d) => d.id)).toEqual(['d2']);

      const cursorBeforeU2 = await db
        .collection('docs')
        .orderBy('ownerRef', 'asc')
        .endCursor([u2Ref], false)
        .get();
      expect(cursorBeforeU2.docs.map((d) => d.id)).toEqual(['d1', 'd3']);

      // startCursorFromSnapshot / endCursorFromSnapshot from both get() and live onSnapshot()
      await db.doc('docs/d1').update({ seq: 1 });
      await db.doc('docs/d3').update({ seq: 2 });
      await db.doc('docs/d2').update({ seq: 3 });

      const d3OneShot = await db.doc('docs/d3').get();
      const afterD3OneShot = await db
        .collection('docs')
        .orderBy('ownerRef', 'asc')
        .orderBy('seq', 'asc')
        .startCursorFromSnapshot(d3OneShot, false)
        .get();
      expect(afterD3OneShot.docs.map((d) => d.id)).toEqual(['d2']);

      let liveD3Snap: unknown;
      const unsubQuery = onSnapshot(
        db.collection('docs').orderBy('seq', 'asc'),
        (qSnap) => {
          liveD3Snap = qSnap.docs.find((d) => d.id === 'd3');
        },
      );
      await new Promise((r) => setTimeout(r, 25));
      unsubQuery();
      expect(liveD3Snap).toBeDefined();

      const afterD3Live = await db
        .collection('docs')
        .orderBy('ownerRef', 'asc')
        .orderBy('seq', 'asc')
        .startCursorFromSnapshot(liveD3Snap as typeof d3OneShot, false)
        .get();
      expect(afterD3Live.docs.map((d) => d.id)).toEqual(['d2']);

      const upToD3Live = await db
        .collection('docs')
        .orderBy('ownerRef', 'asc')
        .orderBy('seq', 'asc')
        .endCursorFromSnapshot(liveD3Snap as typeof d3OneShot, true)
        .get();
      expect(upToD3Live.docs.map((d) => d.id)).toEqual(['d1', 'd3']);
    } finally {
      await deleteApp(app);
    }
  });

  test('stores Buffer and Uint8Array values as bytes, satisfies is-bytes security rules, and returns defensive Buffer copies on read', async () => {
    const { app, host } = makeArm(REFERENCE_RULES);
    try {
      const db = getFirestore(app);
      const backing = new Uint8Array([99, 7, 8, 99]);
      const subarrayView = backing.subarray(1, 3);

      await db.doc('items/from-buffer').set({
        payload: Buffer.from([1, 2, 3]),
        nested: { slice: subarrayView },
        chunks: [new Uint8Array([10, 20])],
      });
      await db.doc('items/from-uint8').set({
        payload: new Uint8Array([4, 5, 6]),
      });

      // Rule-enforced client reads (`resource.data.payload is bytes`)
      const authedClientDb = getClientFirestore(host.withAuth({ uid: 'u1', token: {} }));
      const clientBufSnap = await clientGetDoc(clientDoc(authedClientDb, 'items', 'from-buffer'));
      expect(clientBufSnap.exists()).toBe(true);
      const clientU8Snap = await clientGetDoc(clientDoc(authedClientDb, 'items', 'from-uint8'));
      expect(clientU8Snap.exists()).toBe(true);

      if (isSandboxAdminApp(app)) {
        const ruleDb = getRuleEnforcedFirestore(app.sandbox.withAuth({ uid: 'u1', token: {} }));
        expect((await ruleDb.doc('items/from-buffer').get()).exists).toBe(true);
        expect((await ruleDb.doc('items/from-uint8').get()).exists).toBe(true);
      }

      // Admin read-back returns Buffer (which is also instanceof Uint8Array) with anti-aliasing
      const bufSnap = await db.doc('items/from-buffer').get();
      const firstPayload = bufSnap.data()!.payload as Buffer;
      expect(Buffer.isBuffer(firstPayload)).toBe(true);
      expect(firstPayload instanceof Uint8Array).toBe(true);
      expect(Array.from(firstPayload)).toEqual([1, 2, 3]);

      firstPayload[0] = 255;
      const secondPayload = bufSnap.data()!.payload as Buffer;
      expect(Array.from(secondPayload)).toEqual([1, 2, 3]);

      const nestedSlice = bufSnap.get('nested.slice') as Buffer;
      expect(Buffer.isBuffer(nestedSlice)).toBe(true);
      expect(Array.from(nestedSlice)).toEqual([7, 8]);

      const u8ReadBack = (await db.doc('items/from-uint8').get()).data()!.payload as Buffer;
      expect(Buffer.isBuffer(u8ReadBack)).toBe(true);
      expect(Array.from(u8ReadBack)).toEqual([4, 5, 6]);

      // Update + arrayUnion with Buffer / Uint8Array
      await db.doc('items/from-buffer').update({
        chunks: FieldValue.arrayUnion(Buffer.from([30, 40])),
      });
      const chunks = ((await db.doc('items/from-buffer').get()).data()!.chunks as Buffer[]);
      expect(chunks.map((c) => Array.from(c))).toEqual([[10, 20], [30, 40]]);

      // Query equality with Buffer and Uint8Array
      const byBuf = await db.collection('items').where('payload', '==', Buffer.from([1, 2, 3])).get();
      expect(byBuf.docs.map((d) => d.id)).toEqual(['from-buffer']);
      expect(Buffer.isBuffer(byBuf.docs[0]!.data().payload)).toBe(true);

      const byU8 = await db.collection('items').where('payload', '==', new Uint8Array([4, 5, 6])).get();
      expect(byU8.docs.map((d) => d.id)).toEqual(['from-uint8']);

      // Live onSnapshot rehydration + applyFilter + cursors + caller Buffer mutation isolation
      let liveU8DocSnap: unknown;
      const seenBytes: number[][] = [];
      const unsub = onSnapshot(db.doc('items/from-uint8'), (liveSnap) => {
        liveU8DocSnap = liveSnap;
        const p = liveSnap.data()?.payload;
        if (Buffer.isBuffer(p)) seenBytes.push(Array.from(p));
      });
      await new Promise((r) => setTimeout(r, 25));
      unsub();
      expect(seenBytes).toEqual([[4, 5, 6]]);
      expect(liveU8DocSnap).toBeDefined();

      const whereOperand = Buffer.from([1, 2, 3]);
      const filterOperand = Buffer.from([4, 5, 6]);
      const cursorOperand = Buffer.from([4, 5, 6]);

      const whereQuery = db.collection('items').where('payload', '==', whereOperand);
      const applyFilterQuery = db.collection('items').applyFilter({
        kind: 'where',
        field: 'payload',
        op: '==',
        value: filterOperand,
      });
      const startCursorQuery = db
        .collection('items')
        .orderBy('payload', 'asc')
        .startCursor([cursorOperand], true);
      const endCursorQuery = db
        .collection('items')
        .orderBy('payload', 'asc')
        .endCursor([cursorOperand], false);

      // Mutate caller Buffers AFTER constructing the queries/cursors
      whereOperand[0] = 222;
      filterOperand[0] = 222;
      cursorOperand[0] = 0;

      expect((await whereQuery.get()).docs.map((d) => d.id)).toEqual(['from-buffer']);
      expect((await applyFilterQuery.get()).docs.map((d) => d.id)).toEqual(['from-uint8']);
      expect((await startCursorQuery.get()).docs.map((d) => d.id)).toEqual(['from-uint8']);
      expect((await endCursorQuery.get()).docs.map((d) => d.id)).toEqual(['from-buffer']);

      // Snapshot cursors on bytes fields from both get() and live onSnapshot()
      const fromBufSnap = await db.doc('items/from-buffer').get();
      const afterBufSnap = await db
        .collection('items')
        .orderBy('payload', 'asc')
        .startCursorFromSnapshot(fromBufSnap, false)
        .get();
      expect(afterBufSnap.docs.map((d) => d.id)).toEqual(['from-uint8']);

      const upToLiveU8 = await db
        .collection('items')
        .orderBy('payload', 'asc')
        .endCursorFromSnapshot(liveU8DocSnap as typeof fromBufSnap, false)
        .get();
      expect(upToLiveU8.docs.map((d) => d.id)).toEqual(['from-buffer']);
    } finally {
      await deleteApp(app);
    }
  });
});
