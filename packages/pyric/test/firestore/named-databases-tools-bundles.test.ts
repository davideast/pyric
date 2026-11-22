/**
 * Named-database tests for `packages/pyric/src/firestore`:
 * - `createFirestoreDataTools` & `createFirestoreInspectTools` (`database` routing)
 * - per-database `undo` and `redo`
 * - `loadBundle`, `namedQuery`, `documentSnapshotFromJSON`, `querySnapshotFromJSON`,
 *   and `onSnapshotResume` carrying `databaseId` and rejecting cross-database
 *   bundles/snapshots with Firebase JS SDK 12.19.0's exact error message.
 */
import { describe, expect, it } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  collection,
  createFirestoreDataTools,
  createFirestoreInspectTools,
  doc,
  documentSnapshotFromJSON,
  getAdminFirestore,
  getDoc,
  getDocs,
  getFirestore,
  loadBundle,
  namedQuery,
  onSnapshotResume,
  querySnapshotFromJSON,
  setDoc,
} from 'pyric/firestore';
import { declareFirestoreDatabase, getDatabaseEnv } from 'pyric/firestore/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { redo, undo } from 'pyric/sandbox/firestore';

function buildNamedBundlePayload(projectId: string, databaseId: string): string {
  const metadata = JSON.stringify({
    metadata: {
      id: 'bundle-reports',
      createTime: '2026-01-01T00:00:00.000000000Z',
      version: 1,
      totalDocuments: 1,
      totalBytes: 256,
    },
  });
  const named = JSON.stringify({
    namedQuery: {
      name: 'featured-reports',
      readTime: '2026-01-01T00:00:01.000000000Z',
      bundledQuery: {
        parent: `projects/${projectId}/databases/${databaseId}/documents`,
        structuredQuery: {
          from: [{ collectionId: 'items' }],
        },
        limitType: 'FIRST',
      },
    },
  });
  const docMeta = JSON.stringify({
    documentMetadata: {
      name: `projects/${projectId}/databases/${databaseId}/documents/items/r1`,
      readTime: '2026-01-01T00:00:01.000000000Z',
      exists: true,
      queries: ['featured-reports'],
    },
  });
  const document = JSON.stringify({
    document: {
      name: `projects/${projectId}/databases/${databaseId}/documents/items/r1`,
      createTime: '2026-01-01T00:00:01.000000000Z',
      updateTime: '2026-01-01T00:00:01.000000000Z',
      fields: {
        title: { stringValue: 'Q4 Summary' },
        otherRef: {
          referenceValue: `projects/${projectId}/databases/(default)/documents/users/alice`,
        },
      },
    },
  });
  return [metadata, named, docMeta, document]
    .map((element) => `${new TextEncoder().encode(element).byteLength}${element}`)
    .join('');
}

describe('pyric firestore named-database tools, undo/redo, and bundles/SSR', () => {
  it('routes createFirestoreDataTools, createFirestoreInspectTools, and undo/redo per database', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');

    const tools = createFirestoreDataTools({
      resolveDb: (_as, database) => getAdminFirestore(sandbox.withAuth(null), database),
    });
    const inspectTools = createFirestoreInspectTools({ resolveSandbox: () => sandbox });

    const createTool = tools.find((t) => t.name === 'firestore_create_document')!;
    const getTool = tools.find((t) => t.name === 'firestore_get_document')!;
    const inspectTool = inspectTools.find((t) => t.name === 'sandbox_inspect')!;

    await createTool.execute(
      { path: 'items/shared', data: { source: 'default-v1' } },
      { signal: new AbortController().signal } as never,
    );
    await createTool.execute(
      { path: 'items/shared', data: { source: 'reports-v1' }, database: 'reports' },
      { signal: new AbortController().signal } as never,
    );
    await createTool.execute(
      { path: 'items/shared', data: { source: 'reports-v2' }, database: 'reports' },
      { signal: new AbortController().signal } as never,
    );

    const inspectReports = await inspectTool.execute(
      { database: 'reports' },
      { signal: new AbortController().signal } as never,
    );
    expect(inspectReports.ok).toBe(true);
    expect(
      (inspectReports.data as { documents: { totalCount: number } }).documents.totalCount,
    ).toBe(1);

    const undone = undo(sandbox, 'reports');
    expect(undone.undone).toBe(true);
    expect(getDatabaseEnv(sandbox, 'reports').getDocument('items/shared')).toEqual({
      source: 'reports-v1',
    });

    const defaultSnap = await getTool.execute(
      { path: 'items/shared' },
      { signal: new AbortController().signal } as never,
    );
    expect((defaultSnap.data as { data: Record<string, unknown> }).data).toEqual({
      source: 'default-v1',
    });

    const redone = redo(sandbox, 'reports');
    expect(redone.redone).toBe(true);
    const reportsAfterRedo = await getTool.execute(
      { path: 'items/shared', database: 'reports' },
      { signal: new AbortController().signal } as never,
    );
    expect((reportsAfterRedo.data as { data: Record<string, unknown> }).data).toEqual({
      source: 'reports-v2',
    });
  });

  it('loads bundles and SSR snapshots into the matching named database and rejects cross-database payloads', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');
    const app = createAppForSandbox(sandbox, { projectId: 'demo-proj' }, 'bundle-app');
    const defaultDb = getFirestore(sandbox);
    const reportsDb = getFirestore(sandbox, 'reports');
    void app;

    const payload = buildNamedBundlePayload('demo-proj', 'reports');
    await loadBundle(reportsDb, payload);

    const loadedDoc = await getDoc(doc(reportsDb, 'items/r1'));
    expect(loadedDoc.exists()).toBe(true);
    expect(loadedDoc.data()?.title).toBe('Q4 Summary');
    expect((await getDoc(doc(defaultDb, 'items/r1'))).exists()).toBe(false);

    const nq = await namedQuery(reportsDb, 'featured-reports');
    expect(nq).not.toBeNull();
    expect(await namedQuery(defaultDb, 'featured-reports')).toBeNull();

    let crossDbBundleError: unknown = null;
    try {
      await loadBundle(defaultDb, payload);
    } catch (err) {
      crossDbBundleError = err;
    }
    expect(crossDbBundleError).toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining(
        'Tried to deserialize key from different database: reports vs (default)',
      ),
    });

    await setDoc(doc(getAdminFirestore(sandbox.withAuth(null), 'reports'), 'items/ssr'), {
      label: 'SSR Row',
    });
    const reportsSnap = await getDoc(doc(reportsDb, 'items/ssr'));
    const docJson = reportsSnap.toJSON();

    const rehydrated = documentSnapshotFromJSON(reportsDb, docJson);
    expect(rehydrated.data()).toEqual({ label: 'SSR Row' });

    expect(() => documentSnapshotFromJSON(defaultDb, docJson)).toThrow(
      /Tried to deserialize key from different database: reports vs \(default\)/,
    );

    const reportsQueryJson = (await getDocs(collection(reportsDb, 'items'))).toJSON();
    expect(() => querySnapshotFromJSON(defaultDb, reportsQueryJson)).toThrow(
      /Tried to deserialize key from different database: reports vs \(default\)/,
    );

    const resumeError = await new Promise<unknown>((resolve) => {
      const unsub = onSnapshotResume(
        defaultDb,
        docJson,
        () => {},
        (err) => {
          unsub();
          resolve(err);
        },
      );
    });
    expect(String((resumeError as Error | null)?.message ?? '')).toContain(
      'Tried to deserialize key from different database: reports vs (default)',
    );
  });
});
