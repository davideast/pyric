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
  type Firestore,
  type FirestoreDataConverter,
  type PartialWithFieldValue,
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
      const upRawBacktickWhere = upstreamFs.query(
        upColl,
        upstreamFs.where('`meta.tag`', '==', 'alpha-literal'),
      );
      expect(upstreamFs.queryEqual(upLiteralWhere, upNestedWhere)).toBe(false);
      expect(upstreamFs.queryEqual(upNestedWhere, upSegmentedWhere)).toBe(true);
      expect(upstreamFs.queryEqual(upRawBacktickWhere, upLiteralWhere)).toBe(false);

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);
      const items = collection(db, 'items');

      await setDoc(doc(db, 'items/doc-1'), {
        'meta.tag': 'alpha-literal',
        'a/b': 1,
        'a.b': { 'c/d': 'slash-dot-1' },
        '`meta': { 'tag`': 'backtick-nested' },
        meta: { tag: 'zzz-nested', 'sub.key': 10 },
      });
      await setDoc(doc(db, 'items/doc-2'), {
        'meta.tag': 'beta-literal',
        'a/b': 2,
        'a.b': { 'c/d': 'slash-dot-2' },
        meta: { tag: 'mmm-nested', 'sub.key': 20 },
      });
      await setDoc(doc(db, 'items/doc-3'), {
        'meta.tag': 'omega-literal',
        'a/b': 3,
        meta: { tag: 'aaa-nested', 'sub.key': 30 },
      });

      const literalWhere = query(items, where(new FieldPath('meta.tag'), '==', 'alpha-literal'));
      const nestedWhere = query(items, where('meta.tag', '==', 'alpha-literal'));
      const segmentedWhere = query(items, where(new FieldPath('meta', 'tag'), '==', 'alpha-literal'));
      const rawBacktickWhere = query(items, where('`meta.tag`', '==', 'alpha-literal'));

      expect(queryEqual(literalWhere, nestedWhere)).toBe(
        upstreamFs.queryEqual(upLiteralWhere, upNestedWhere),
      );
      expect(queryEqual(nestedWhere, segmentedWhere)).toBe(
        upstreamFs.queryEqual(upNestedWhere, upSegmentedWhere),
      );
      expect(queryEqual(rawBacktickWhere, literalWhere)).toBe(
        upstreamFs.queryEqual(upRawBacktickWhere, upLiteralWhere),
      );

      const literalMatched = await getDocs(literalWhere);
      expect(literalMatched.docs.map((d) => d.id)).toEqual(['doc-1']);

      // Raw backtick string path splits on '.' as ['`meta', 'tag`'] rather than spoofing FieldPath('meta.tag').
      expect((await getDocs(rawBacktickWhere)).docs.map((d) => d.id)).toEqual([]);
      expect(
        (await getDocs(query(items, where('`meta.tag`', '==', 'backtick-nested')))).docs.map(
          (d) => d.id,
        ),
      ).toEqual(['doc-1']);

      // FieldPath segments containing '/', '*~/[]', and mixed '.' + '/' preserve boundaries.
      expect(
        (await getDocs(query(items, where(new FieldPath('a.b', 'c/d'), '==', 'slash-dot-2')))).docs.map(
          (d) => d.id,
        ),
      ).toEqual(['doc-2']);
      const slashOrdered = await getDocs(query(items, orderBy(new FieldPath('a/b'), 'desc')));
      expect(slashOrdered.docs.map((d) => d.id)).toEqual(['doc-3', 'doc-2', 'doc-1']);

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
    it('forwards SetOptions only on merge/mergeFields writes and accepts partial models matching firebase/firestore', async () => {
      interface ItemModel {
        title: string;
        count: number;
      }

      const buildConverter = (
        recorded: Array<{ argCount: number; options: SetOptions | undefined }>,
      ): FirestoreDataConverter<ItemModel> => ({
        toFirestore(model, options?: SetOptions) {
          recorded.push({ argCount: arguments.length, options });
          if (options && (options.merge || options.mergeFields !== undefined)) {
            const partial: Record<string, unknown> = {};
            if ('title' in model && model.title !== undefined) partial.title = model.title;
            if ('count' in model && model.count !== undefined) partial.count = model.count;
            return partial;
          }
          const full = model as ItemModel;
          return { title: full.title, count: full.count };
        },
        fromFirestore(snapshot) {
          const raw = snapshot.data();
          return { title: String(raw.title), count: Number(raw.count) };
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
      upBatch.set(upRef, { title: 'overwritten', count: 9 }, { merge: false });
      upBatch.set(upRef, { title: 'empty-options', count: 12 }, {});

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);
      const pyricRecorded: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const converter = buildConverter(pyricRecorded);

      const batchDoc = doc(db, 'items/doc-1').withConverter(converter);
      const batch = writeBatch(db);
      batch.set(batchDoc, { title: 'initial', count: 5 });
      batch.set(batchDoc, { title: 'renamed' }, { merge: true });
      batch.set(batchDoc, { title: 'masked' }, { mergeFields: ['title'] });
      batch.set(batchDoc, { title: 'overwritten', count: 9 }, { merge: false });
      batch.set(batchDoc, { title: 'empty-options', count: 12 }, {});
      await batch.commit();

      expect(pyricRecorded).toEqual(upstreamRecorded);
      expect(pyricRecorded).toEqual([
        { argCount: 1, options: undefined },
        { argCount: 2, options: { merge: true } },
        { argCount: 2, options: { mergeFields: ['title'] } },
        { argCount: 1, options: undefined },
        { argCount: 1, options: undefined },
      ]);
      expect((await getDoc(batchDoc)).data()).toEqual({ title: 'empty-options', count: 12 });

      const setDocCalls: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const setConv = buildConverter(setDocCalls);
      const singleDoc = doc(db, 'items/doc-2').withConverter(setConv);
      await setDoc(singleDoc, { title: 'first', count: 7 });
      await setDoc(singleDoc, { title: 'second' }, { merge: true });
      await setDoc(singleDoc, { title: 'third', count: 30 }, { merge: false });
      await setDoc(singleDoc, { title: 'fourth', count: 40 }, {});
      expect(setDocCalls).toEqual([
        { argCount: 1, options: undefined },
        { argCount: 2, options: { merge: true } },
        { argCount: 1, options: undefined },
        { argCount: 1, options: undefined },
      ]);
      expect((await getDoc(singleDoc)).data()).toEqual({ title: 'fourth', count: 40 });

      const txCalls: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const txConv = buildConverter(txCalls);
      const txDoc = doc(db, 'items/doc-3').withConverter(txConv);
      await setDoc(txDoc, { title: 'tx-init', count: 11 });
      await runTransaction(db, async (tx) => {
        tx.set(txDoc, { title: 'tx-merged' }, { mergeFields: ['title'] });
      });
      await runTransaction(db, async (tx) => {
        tx.set(txDoc, { title: 'tx-replaced', count: 22 }, { merge: false });
      });
      expect(txCalls).toEqual([
        { argCount: 1, options: undefined },
        { argCount: 2, options: { mergeFields: ['title'] } },
        { argCount: 1, options: undefined },
      ]);
      expect((await getDoc(txDoc)).data()).toEqual({ title: 'tx-replaced', count: 22 });

      const addCalls: Array<{ argCount: number; options: SetOptions | undefined }> = [];
      const createdRef = await addDoc(collection(db, 'items').withConverter(buildConverter(addCalls)), {
        title: 'added',
        count: 3,
      });
      expect(addCalls).toEqual([{ argCount: 1, options: undefined }]);
      expect((await getDoc(createdRef)).data()).toEqual({ title: 'added', count: 3 });

      // 1-arg converters (unannotated method, typed 1-arg method, arrow property, and class implements) remain compatible under strict types.
      const unannotatedMethodConverter: FirestoreDataConverter<ItemModel> = {
        toFirestore(m) {
          return { title: (m as ItemModel).title, count: (m as ItemModel).count };
        },
        fromFirestore: (s) => ({ title: String(s.data().title), count: Number(s.data().count) }),
      };
      const typedMethodConverter: FirestoreDataConverter<ItemModel> = {
        toFirestore(m: ItemModel) {
          return { title: m.title, count: m.count };
        },
        fromFirestore: (s) => ({ title: String(s.data().title), count: Number(s.data().count) }),
      };
      const arrowConverter: FirestoreDataConverter<ItemModel> = {
        toFirestore: (m: PartialWithFieldValue<ItemModel>) => ({
          title: typeof m.title === 'string' ? m.title : '',
          count: typeof m.count === 'number' ? m.count : 0,
        }),
        fromFirestore: (s) => ({ title: String(s.data().title), count: Number(s.data().count) }),
      };
      class ClassConverter implements FirestoreDataConverter<ItemModel> {
        toFirestore(m: PartialWithFieldValue<ItemModel>) {
          return {
            title: typeof m.title === 'string' ? m.title : '',
            count: typeof m.count === 'number' ? m.count : 0,
          };
        }
        fromFirestore(s: import('pyric/firestore').QueryDocumentSnapshot): ItemModel {
          return { title: String(s.data().title), count: Number(s.data().count) };
        }
      }
      await setDoc(doc(db, 'items/conv-method').withConverter(unannotatedMethodConverter), {
        title: 'm',
        count: 1,
      });
      await setDoc(doc(db, 'items/conv-typed-method').withConverter(typedMethodConverter), {
        title: 'tm',
        count: 4,
      });
      await setDoc(doc(db, 'items/conv-arrow').withConverter(arrowConverter), {
        title: 'a',
        count: 2,
      });
      await setDoc(doc(db, 'items/conv-class').withConverter(new ClassConverter()), {
        title: 'c',
        count: 3,
      });
      expect((await getDoc(doc(db, 'items/conv-class').withConverter(new ClassConverter()))).data()).toEqual({
        title: 'c',
        count: 3,
      });
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
      expect(getFirestore(app) as Firestore).toBe(dbReinitialized);
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
      expect(
        queryEqual(
          collection(getFirestore(sandbox1), 'items'),
          collection(getFirestore(sandbox1, 'analytics'), 'items'),
        ),
      ).toBe(false);
      expect(
        queryEqual(
          collection(getFirestore(sandbox1), 'items'),
          collection(getFirestore(sandbox1, '(default)'), 'items'),
        ),
      ).toBe(true);
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
