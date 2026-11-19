import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  FirestoreError,
  LoadBundleTask,
  Query,
  doc,
  getDocFromCache,
  getDocsFromCache,
  getFirestore,
  loadBundle,
  namedQuery,
  type LoadBundleTaskProgress,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

function encodeElements(elements: readonly unknown[]): string {
  const enc = new TextEncoder();
  let out = '';
  for (const el of elements) {
    const json = JSON.stringify(el);
    out += `${enc.encode(json).byteLength}${json}`;
  }
  return out;
}

function sampleArticlesBundle(): string {
  const parent = 'projects/demo-bundle/databases/(default)/documents';
  const body = encodeElements([
    {
      namedQuery: {
        name: 'published-articles',
        readTime: '2026-01-15T12:00:00.000000000Z',
        bundledQuery: {
          parent,
          structuredQuery: {
            from: [{ collectionId: 'articles' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'published' },
                op: 'EQUAL',
                value: { booleanValue: true },
              },
            },
            orderBy: [{ field: { fieldPath: 'rank' }, direction: 'ASCENDING' }],
          },
          limitType: 'FIRST',
        },
      },
    },
    {
      documentMetadata: {
        name: `${parent}/articles/alpha`,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: true,
        queries: ['published-articles'],
      },
    },
    {
      document: {
        name: `${parent}/articles/alpha`,
        fields: {
          title: { stringValue: 'First Post' },
          published: { booleanValue: true },
          rank: { integerValue: '1' },
        },
      },
    },
    {
      documentMetadata: {
        name: `${parent}/articles/ghost`,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: false,
        queries: [],
      },
    },
  ]);
  const totalBytes = new TextEncoder().encode(body).byteLength;
  const header = encodeElements([
    {
      metadata: {
        id: 'articles-v1',
        createTime: '2026-01-15T12:00:00.000000000Z',
        version: 1,
        totalDocuments: 2,
        totalBytes,
      },
    },
  ]);
  return header + body;
}

describe('loadBundle, LoadBundleTask, and namedQuery', () => {
  it('loads string, Uint8Array, and ReadableStream bundles with progress and namedQuery hydration', async () => {
    const db = getFirestore(initializeSandbox());
    const bundle = sampleArticlesBundle();
    const steps: LoadBundleTaskProgress[] = [];
    let completed = false;
    const task = loadBundle(db, bundle);
    expect(task).toBeInstanceOf(LoadBundleTask);
    task.onProgress(
      (p) => steps.push(p),
      undefined,
      () => { completed = true; },
    );
    const finalProgress = await task;
    expect(completed).toBe(true);
    expect(finalProgress.taskState).toBe('Success');
    expect(finalProgress.documentsLoaded).toBe(2);
    expect(steps.length).toBe(4);

    const alpha = await getDocFromCache(doc(db, 'articles/alpha'));
    expect(alpha.exists()).toBe(true);
    expect(alpha.metadata.fromCache).toBe(true);
    expect(alpha.data()).toEqual({ title: 'First Post', published: true, rank: 1 });

    const ghost = await getDocFromCache(doc(db, 'articles/ghost'));
    expect(ghost.exists()).toBe(false);
    expect(ghost.metadata.fromCache).toBe(true);
    expect(ghost.data()).toBeUndefined();

    const q = await namedQuery(db, 'published-articles');
    expect(q).toBeInstanceOf(Query);
    expect(await namedQuery(db, 'missing')).toBeNull();
    const qSnap = await getDocsFromCache(q as Query);
    expect(qSnap.size).toBe(1);
    expect(qSnap.metadata.fromCache).toBe(true);
    expect(qSnap.docs.map((d) => d.id)).toEqual(['alpha']);

    const dbStream = getFirestore(initializeSandbox());
    const bytes = new TextEncoder().encode(bundle);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 40));
        controller.enqueue(bytes.subarray(40));
        controller.close();
      },
    });
    const streamProgress = await loadBundle(dbStream, stream);
    expect(streamProgress.taskState).toBe('Success');
  });

  it('rejects raw ArrayBuffer synchronously with FirebaseError(invalid-argument) and rejects malformed payloads asynchronously with plain Error', async () => {
    const db = getFirestore(initializeSandbox());
    expect(() => loadBundle(db, new ArrayBuffer(8))).toThrow(FirebaseError);

    let progressErr: unknown;
    const badTask = loadBundle(db, 'not-a-valid-bundle');
    badTask.onProgress(undefined, (err) => { progressErr = err; });
    let rejected: unknown;
    try {
      await badTask;
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toBeInstanceOf(FirebaseError);
    expect(rejected).not.toBeInstanceOf(FirestoreError);
    expect(progressErr).toBe(rejected);
  });
});
