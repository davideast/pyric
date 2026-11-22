import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection,
  createFirestoreDataTools,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  writeBatch,
  type As,
} from '../../src/firestore/index.js';
import { setRules } from 'pyric/sandbox/firestore';

function buildToolsFor(sandbox: ReturnType<typeof initializeSandbox>) {
  const handlers = createFirestoreDataTools({
    resolveDb(actor?: As, databaseId?: string) {
      if (actor === undefined || actor === 'admin') {
        if (databaseId !== undefined) return getAdminFirestore(sandbox, databaseId);
        return getAdminFirestore(sandbox);
      }
      const auth = {
        uid: actor.uid,
        token: actor.claims ?? {},
      };
      const scoped = sandbox.withAuth(auth);
      if (databaseId !== undefined) return getFirestore(scoped, databaseId);
      return getFirestore(scoped);
    },
  });
  return async (name: string, args: Record<string, unknown>) => {
    const found = handlers.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`missing tool ${name}`);
    return found.execute(args, { signal: new AbortController().signal } as never);
  };
}

describe('createFirestoreDataTools parity with pyric/firestore', () => {
  it('matches library setDoc merge on missing docs, nested maps, and dotted keys (#1915)', async () => {
    const toolSb = initializeSandbox();
    const libSb = initializeSandbox();
    const runTool = buildToolsFor(toolSb);
    const libDb = getAdminFirestore(libSb);
    const toolDb = getAdminFirestore(toolSb);

    await runTool('firestore_create_document', {
      path: 'users/missing',
      data: { profile: { name: 'Ada' }, 'x.y': 1 },
      options: { merge: true },
    });
    await setDoc(
      doc(libDb, 'users/missing'),
      { profile: { name: 'Ada' }, 'x.y': 1 },
      { merge: true },
    );
    expect((await getDoc(doc(toolDb, 'users/missing'))).data()).toEqual(
      (await getDoc(doc(libDb, 'users/missing'))).data(),
    );

    await setDoc(doc(toolDb, 'users/nested'), { a: { c: 2 }, keep: true });
    await setDoc(doc(libDb, 'users/nested'), { a: { c: 2 }, keep: true });

    await runTool('firestore_batch_write', {
      operations: [
        {
          op: 'set',
          path: 'users/nested',
          data: { a: { b: 1 }, 'x.y': 9 },
          options: { merge: true },
        },
        {
          op: 'set',
          path: 'users/batch-created',
          data: { 'dot.key': 'literal' },
          options: { merge: true },
        },
      ],
    });
    const batch = writeBatch(libDb);
    batch.set(doc(libDb, 'users/nested'), { a: { b: 1 }, 'x.y': 9 }, { merge: true });
    batch.set(doc(libDb, 'users/batch-created'), { 'dot.key': 'literal' }, { merge: true });
    await batch.commit();

    expect((await getDoc(doc(toolDb, 'users/nested'))).data()).toEqual({
      a: { b: 1, c: 2 },
      keep: true,
      'x.y': 9,
    });
    expect((await getDoc(doc(toolDb, 'users/nested'))).data()).toEqual(
      (await getDoc(doc(libDb, 'users/nested'))).data(),
    );
    expect((await getDoc(doc(toolDb, 'users/batch-created'))).data()).toEqual(
      (await getDoc(doc(libDb, 'users/batch-created'))).data(),
    );
  });

  it('commits firestore_batch_write atomically on missing update targets and rules denials (#1916)', async () => {
    const sb = initializeSandbox();
    const runTool = buildToolsFor(sb);
    const adminDb = getAdminFirestore(sb);

    await expect(
      runTool('firestore_batch_write', {
        operations: [
          { op: 'set', path: 'a/first', data: { v: 1 } },
          { op: 'update', path: 'a/missing', data: { v: 2 } },
        ],
      }),
    ).rejects.toThrow();
    expect((await getDoc(doc(adminDb, 'a/first'))).exists()).toBe(false);

    setRules(
      sb,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          match /public/{id} { allow read, write: if true; }
          match /private/{id} { allow read, write: if false; }
        }
      }`,
    );
    await expect(
      runTool('firestore_batch_write', {
        as: { uid: 'alice' },
        operations: [
          { op: 'set', path: 'public/first', data: { v: 1 } },
          { op: 'set', path: 'private/second', data: { v: 2 } },
        ],
      }),
    ).rejects.toThrow();
    expect((await getDoc(doc(adminDb, 'public/first'))).exists()).toBe(false);
  });

  it('applies every orderBy before limit and refuses limit: 0 (#1917)', async () => {
    const sb = initializeSandbox();
    const runTool = buildToolsFor(sb);
    const db = getAdminFirestore(sb);

    const rows: Array<[string, string, number]> = [
      ['a', 'g1', 1],
      ['b', 'g1', 2],
      ['c', 'g2', 3],
      ['d', 'g2', 4],
      ['e', 'g2', 5],
    ];
    for (const [id, group, score] of rows) {
      await setDoc(doc(db, `scores/${id}`), { group, score });
    }

    const toolTop2 = await runTool('firestore_list_documents', {
      collection: 'scores',
      orderBy: [{ field: 'score', direction: 'desc' }],
      limit: 2,
    });
    const libTop2 = await getDocs(
      query(collection(db, 'scores'), orderBy('score', 'desc'), limit(2)),
    );
    expect((toolTop2.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual([
      'e',
      'd',
    ]);
    expect((toolTop2.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual(
      libTop2.docs.map((d) => d.id),
    );

    const multiOrder = await runTool('firestore_query_where', {
      collection: 'scores',
      where: [{ field: 'score', op: '>=', value: 1 }],
      orderBy: [
        { field: 'score', direction: 'desc' },
        { field: 'group', direction: 'asc' },
      ],
      limit: 3,
    });
    expect((multiOrder.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual([
      'e',
      'd',
      'c',
    ]);

    await expect(
      runTool('firestore_list_documents', { collection: 'scores', limit: 0 }),
    ).rejects.toThrow();
    await expect(
      runTool('firestore_query_where', {
        collection: 'scores',
        where: [{ field: 'group', op: '==', value: 'g2' }],
        limit: 0,
      }),
    ).rejects.toThrow();
  });
});
