import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as upstreamApp from 'firebase/app';
import * as upstreamFs from 'firebase/firestore';
import * as upstreamAdminFs from 'firebase-admin/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  addDoc,
  aggregateQuerySnapshotEqual,
  and,
  collection,
  doc,
  FieldPath,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  initializeFirestore,
  or,
  orderBy,
  query,
  queryEqual,
  refEqual,
  runTransaction,
  setDoc,
  startAfter,
  terminate,
  Timestamp,
  where,
  writeBatch,
  type FirestoreDataConverter,
  type SetOptions,
} from 'pyric/firestore';

describe('Firestore client SDK differential contracts', () => {
  beforeEach(async () => {
    await resetAppRegistryForTests();
  });

  afterEach(async () => {
    await Promise.all(upstreamApp.getApps().map((app) => upstreamApp.deleteApp(app).catch(() => {})));
    await Promise.all(getApps().map((app) => deleteApp(app).catch(() => {})));
    await resetAppRegistryForTests();
  });
  describe('FieldPath literal-dot segment boundaries in query constraints', () => {
    it('preserves literal-dot segments across where, composite filters, orderBy, snapshot cursors, and queryEqual matching firebase/firestore', async () => {
      const upApp = upstreamApp.initializeApp(
        { projectId: 'project-alpha', apiKey: 'test-key' },
        'up-fieldpath-dots',
      );
      const upDb = upstreamFs.getFirestore(upApp);
      const upColl = upstreamFs.collection(upDb, 'items');
      const upLiteralWhere = upstreamFs.query(
        upColl,
        upstreamFs.where(new upstreamFs.FieldPath('meta.tag'), '==', 'alpha-literal'),
      );
      const upNestedWhere = upstreamFs.query(
        upColl,
        upstreamFs.where('meta.tag', '==', 'alpha-literal'),
      );
      const upSegmentedWhere = upstreamFs.query(
        upColl,
        upstreamFs.where(new upstreamFs.FieldPath('meta', 'tag'), '==', 'alpha-literal'),
      );
      expect(upstreamFs.queryEqual(upLiteralWhere, upNestedWhere)).toBe(false);
      expect(upstreamFs.queryEqual(upNestedWhere, upSegmentedWhere)).toBe(true);

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);
      const items = collection(db, 'items');

      await setDoc(doc(db, 'items/doc-1'), {
        'meta.tag': 'alpha-literal',
        meta: { tag: 'zzz-nested', 'sub.key': 10 },
      });
      await setDoc(doc(db, 'items/doc-2'), {
        'meta.tag': 'beta-literal',
        meta: { tag: 'mmm-nested', 'sub.key': 20 },
      });
      await setDoc(doc(db, 'items/doc-3'), {
        'meta.tag': 'omega-literal',
        meta: { tag: 'aaa-nested', 'sub.key': 30 },
      });

      const literalWhere = query(items, where(new FieldPath('meta.tag'), '==', 'alpha-literal'));
      const nestedWhere = query(items, where('meta.tag', '==', 'alpha-literal'));
      const segmentedWhere = query(items, where(new FieldPath('meta', 'tag'), '==', 'alpha-literal'));

      expect(queryEqual(literalWhere, nestedWhere)).toBe(
        upstreamFs.queryEqual(upLiteralWhere, upNestedWhere),
      );
      expect(queryEqual(nestedWhere, segmentedWhere)).toBe(
        upstreamFs.queryEqual(upNestedWhere, upSegmentedWhere),
      );

      const literalMatched = await getDocs(literalWhere);
      expect(literalMatched.docs.map((d) => d.id)).toEqual(['doc-1']);

      const compositeMatched = await getDocs(
        query(
          items,
          and(
            or(
              where(new FieldPath('meta.tag'), '==', 'alpha-literal'),
              where(new FieldPath('meta.tag'), '==', 'omega-literal'),
            ),
            where(new FieldPath('meta', 'sub.key'), '>=', 15),
          ),
        ),
      );
      expect(compositeMatched.docs.map((d) => d.id)).toEqual(['doc-3']);

      const ordered = await getDocs(query(items, orderBy(new FieldPath('meta.tag'), 'asc')));
      expect(ordered.docs.map((d) => d.id)).toEqual(['doc-1', 'doc-2', 'doc-3']);

      const doc1Snap = await getDoc(doc(db, 'items/doc-1'));
      const paged = await getDocs(
        query(items, orderBy(new FieldPath('meta.tag'), 'asc'), startAfter(doc1Snap)),
      );
      expect(paged.docs.map((d) => d.id)).toEqual(['doc-2', 'doc-3']);
    });
  });

  describe('FirestoreDataConverter.toFirestore SetOptions forwarding', () => {
    it('forwards SetOptions across setDoc, WriteBatch.set, and Transaction.set matching firebase/firestore', async () => {
      interface ItemModel {
        title?: string;
        count?: number;
      }

      const buildConverter = (recorded: Array<{ argCount: number; options: SetOptions | undefined }>): FirestoreDataConverter<ItemModel> => ({
        toFirestore(model: ItemModel, options?: SetOptions) {
          recorded.push({ argCount: arguments.length, options });
          if (options) {
            const partial: Record<string, unknown> = {};
            if ('title' in model && model.title !== undefined) partial.title = model.title;
            if ('count' in model && model.count !== undefined) partial.count = model.count;
            return partial;
          }
          return { title: model.title ?? 'untitled', count: model.count ?? 0 };
        },
        fromFirestore(snapshot) {
          return snapshot.data() as ItemModel;
        },
      });

      const upstreamRecorded: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const upApp = upstreamApp.initializeApp(
        { projectId: 'project-alpha', apiKey: 'test-key' },
        'up-converter-options',
      );
      const upDb = upstreamFs.getFirestore(upApp);
      const upRef = upstreamFs
        .doc(upDb, 'items/doc-1')
        .withConverter(buildConverter(upstreamRecorded) as unknown as upstreamFs.FirestoreDataConverter<ItemModel>);
      const upBatch = upstreamFs.writeBatch(upDb);
      upBatch.set(upRef, { title: 'initial', count: 5 });
      upBatch.set(upRef, { title: 'renamed' }, { merge: true });
      upBatch.set(upRef, { title: 'masked' }, { mergeFields: ['title'] });

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);
      const pyricRecorded: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const converter = buildConverter(pyricRecorded);

      const batchDoc = doc(db, 'items/doc-1').withConverter(converter);
      const batch = writeBatch(db);
      batch.set(batchDoc, { title: 'initial', count: 5 });
      batch.set(batchDoc, { title: 'renamed' }, { merge: true });
      batch.set(batchDoc, { title: 'masked' }, { mergeFields: ['title'] });
      await batch.commit();

      expect(pyricRecorded).toEqual(upstreamRecorded);
      expect((await getDoc(batchDoc)).data()).toEqual({ title: 'masked', count: 5 });

      const setDocCalls: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const setConv = buildConverter(setDocCalls);
      const singleDoc = doc(db, 'items/doc-2').withConverter(setConv);
      await setDoc(singleDoc, { title: 'first', count: 7 });
      await setDoc(singleDoc, { title: 'second' }, { merge: true });
      expect(setDocCalls).toEqual([
        { argCount: 1, options: undefined },
        { argCount: 2, options: { merge: true } },
      ]);
      expect((await getDoc(singleDoc)).data()).toEqual({ title: 'second', count: 7 });

      const txCalls: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const txConv = buildConverter(txCalls);
      const txDoc = doc(db, 'items/doc-3').withConverter(txConv);
      await setDoc(txDoc, { title: 'tx-init', count: 11 });
      await runTransaction(db, async (tx) => {
        tx.set(txDoc, { title: 'tx-merged' }, { mergeFields: ['title'] });
      });
      expect(txCalls).toEqual([
        { argCount: 1, options: undefined },
        { argCount: 2, options: { mergeFields: ['title'] } },
      ]);
      expect((await getDoc(txDoc)).data()).toEqual({ title: 'tx-merged', count: 11 });

      const addCalls: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const createdRef = await addDoc(collection(db, 'items').withConverter(buildConverter(addCalls)), {
        title: 'added',
      });
      expect(addCalls).toEqual([{ argCount: 1, options: undefined }]);
      expect((await getDoc(createdRef)).data()).toEqual({ title: 'added', count: 0 });
    });
  });

  describe('terminate(db) app service cache eviction', () => {
    it('evicts terminated Firestore handles so getFirestore and initializeFirestore return fresh usable handles while preserving deleted-app retention', async () => {
      const cfg = { projectId: 'project-alpha', apiKey: 'test-key' };

      const upApp = upstreamApp.initializeApp(cfg, 'up-terminate');
      const upDefault1 = upstreamFs.getFirestore(upApp);
      await upstreamFs.terminate(upDefault1);
      const upDefault2 = upstreamFs.getFirestore(upApp);
      await upstreamFs.terminate(upDefault2);
      const upReinitialized = upstreamFs.initializeFirestore(upApp, {});
      await upstreamFs.terminate(upReinitialized);

      const app = initializeApp(cfg, 'pyric-terminate');
      const dbDefault1 = getFirestore(app);

      const heldRef = doc(dbDefault1, 'items/doc-1');
      await setDoc(heldRef, { count: 42 });

      await terminate(dbDefault1);

      await expect(getDoc(heldRef)).rejects.toMatchObject({ code: 'failed-precondition' });

      const dbDefault2 = getFirestore(app);
      expect(dbDefault2 !== dbDefault1).toBe(upDefault2 !== upDefault1);

      // Idempotent second terminate(dbDefault1) must not evict dbDefault2
      await terminate(dbDefault1);
      expect(getFirestore(app)).toBe(dbDefault2);

      const reopenedSnap = await getDoc(doc(dbDefault2, 'items/doc-1'));
      expect(reopenedSnap.data()).toEqual({ count: 42 });

      await terminate(dbDefault2);
      const dbReinitialized = initializeFirestore(app, {});
      expect(dbReinitialized !== dbDefault2).toBe(upReinitialized !== upDefault2);
      expect(getFirestore(app)).toBe(dbReinitialized);
    });
  });

  describe('queryEqual and aggregateQuerySnapshotEqual owner identity', () => {
    it('distinguishes distinct FirebaseApp instances and sandboxes matching firebase/firestore', async () => {
      const cfg = { projectId: 'project-alpha', apiKey: 'test-key' };

      const upAppA = upstreamApp.initializeApp(cfg, 'up-eq-alpha');
      const upAppB = upstreamApp.initializeApp(cfg, 'up-eq-beta');
      const upDbA = upstreamFs.getFirestore(upAppA);
      const upDbB = upstreamFs.getFirestore(upAppB);

      const upSameAppEq = upstreamFs.queryEqual(
        upstreamFs.collection(upDbA, 'items'),
        upstreamFs.collection(upDbA, 'items'),
      );
      const upCrossAppEq = upstreamFs.queryEqual(
        upstreamFs.collection(upDbA, 'items'),
        upstreamFs.collection(upDbB, 'items'),
      );

      const appA = initializeApp(cfg, 'pyric-eq-alpha');
      const appB = initializeApp(cfg, 'pyric-eq-beta');
      const dbA = getFirestore(appA);
      const dbB = getFirestore(appB);
      await setDoc(doc(dbA, 'items/doc-1'), { score: 10 });

      expect(queryEqual(collection(dbA, 'items'), collection(dbA, 'items'))).toBe(upSameAppEq);
      expect(queryEqual(collection(dbA, 'items'), collection(dbB, 'items'))).toBe(upCrossAppEq);
      expect(
        queryEqual(
          query(collection(dbA, 'items'), where('score', '==', 10)),
          query(collection(dbB, 'items'), where('score', '==', 10)),
        ),
      ).toBe(false);
      expect(refEqual(doc(dbA, 'items/doc-1'), doc(dbB, 'items/doc-1'))).toBe(false);

      const aggA = await getCountFromServer(collection(dbA, 'items'));
      const aggB = await getCountFromServer(collection(dbB, 'items'));
      const aggSame = await getCountFromServer(collection(dbA, 'items'));
      expect(aggregateQuerySnapshotEqual(aggA, aggSame)).toBe(true);
      expect(aggregateQuerySnapshotEqual(aggA, aggB)).toBe(false);

      const sandbox1 = initializeSandbox();
      const sandbox2 = initializeSandbox();
      expect(
        queryEqual(
          collection(getFirestore(sandbox1), 'items'),
          collection(getFirestore(sandbox2), 'items'),
        ),
      ).toBe(false);
    });
  });

  describe('Timestamp finite integer validation', () => {
    it('rejects NaN, Infinity, and fractional components matching upstream Firestore Timestamp', () => {
      for (const [sec, nano] of [
        [Number.NaN, 0],
        [0, Number.NaN],
        [Number.POSITIVE_INFINITY, 0],
        [Number.NEGATIVE_INFINITY, 0],
        [1.5, 0],
        [0, 0.5],
        [0, -1],
        [0, 1_000_000_000],
      ] as const) {
        expect(() => new upstreamAdminFs.Timestamp(sec, nano)).toThrow();
        expect(() => new Timestamp(sec, nano)).toThrow();
      }
      expect(() => Timestamp.fromMillis(Number.NaN)).toThrow();
      expect(() => Timestamp.fromDate(new Date('not-a-date'))).toThrow();
      expect(() =>
        upstreamFs.Timestamp.fromJSON({
          type: 'firestore/timestamp/1.0',
          seconds: null as unknown as number,
          nanoseconds: 0,
        }),
      ).toThrow();
    });
  });
});
