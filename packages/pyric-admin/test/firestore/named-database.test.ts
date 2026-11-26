/**
 * Production `getFirestore(app, databaseId)` and `getFirestore(databaseId)`
 * return an Admin handle bound to that named database across both the
 * in-process and remote SharedWorker arms (conformance registry row MD3).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doc as clientDoc, getDoc as clientGetDoc, getFirestore as getClientFirestore } from 'pyric/firestore';
import { getDatabaseEnv } from 'pyric/firestore/internal';
import { declareFirestoreDatabase, setRules } from 'pyric/sandbox/firestore';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  getAdminFirestore,
  getFirestore,
  GrpcStatus,
  initializeFirestore,
  type AdminFirestore,
} from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

interface AdminMixingObservation {
  readonly projectId: string;
  readonly behavior: {
    readonly 'reference-to-other-database': string;
    readonly 'batch-spanning-databases': string;
    readonly 'transaction-reads-and-writes-other-database': string;
  };
  readonly diagnostics: {
    readonly stored: {
      readonly referenceReadBack: {
        readonly path: string;
        readonly databaseId: string;
      };
      readonly referenceValueOnTheWire: string;
      readonly batch: { readonly default: null; readonly probes: null };
      readonly transaction: { readonly default: null; readonly probes: null };
    };
  };
}

function load(stem: string): AdminMixingObservation {
  const filePath = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'conformance',
    'observations',
    'firestore',
    `${stem}.json`,
  );
  return JSON.parse(readFileSync(filePath, 'utf8')) as AdminMixingObservation;
}

const DENY_ALL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const ALLOW_READ_ONLY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if request.auth != null;
      allow write: if false;
    }
  }
}`;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe.each([
  ['in-process', inProcessFirestoreArm],
  ['shared-worker', sharedWorkerFirestoreArm],
] as const)('pyric-admin getFirestore(app, databaseId) and getFirestore(databaseId) (%s, MD3)', (_armName, makeArm) => {
  test('isolates documents per database id across Admin and client handles, bypasses named-db rules on Admin writes, and rejects undeclared databases with 5 NOT_FOUND', async () => {
    const { app, host } = makeArm(DENY_ALL_RULES);
    declareFirestoreDatabase(host, 'reports');
    declareFirestoreDatabase(host, 'archive');
    setRules(host, ALLOW_READ_ONLY_RULES, 'reports');
    const defaultApp = initializeApp({ sandbox: app.sandbox, projectId: 'proj-1' });

    const defaultDb = getFirestore(app);
    const reportsDb = getFirestore(app, 'reports');
    const archiveDb = getFirestore('archive');

    expect(getFirestore(defaultApp, 'archive')).toBe(archiveDb);
    expect(getFirestore(app, '(default)')).toBe(defaultDb);
    expect(getFirestore(app, '')).toBe(defaultDb);

    // Admin bypasses `allow write: if false` on both `(default)` and `'reports'`.
    await defaultDb.doc('rooms/r1').set({ from: 'default' });
    await reportsDb.doc('rooms/r1').set({ from: 'reports' });
    await archiveDb.doc('rooms/r1').set({ from: 'archive' });

    expect((await defaultDb.doc('rooms/r1').get()).data()).toEqual({ from: 'default' });
    expect((await reportsDb.doc('rooms/r1').get()).data()).toEqual({ from: 'reports' });
    expect((await archiveDb.doc('rooms/r1').get()).data()).toEqual({ from: 'archive' });

    // Cross-SDK check: client signed-in handle reads `'reports'` room written by Admin and is denied on `(default)`.
    const authedCtx = host.withAuth({ uid: 'reader-1' });
    const clientReportsSnap = await clientGetDoc(
      clientDoc(getClientFirestore(authedCtx, 'reports'), 'rooms/r1'),
    );
    expect(clientReportsSnap.exists()).toBe(true);
    expect(clientReportsSnap.data()).toEqual({ from: 'reports' });

    let defaultClientDenied = false;
    try {
      await clientGetDoc(clientDoc(getClientFirestore(authedCtx), 'rooms/r1'));
    } catch (err) {
      defaultClientDenied = (err as { code?: unknown }).code === 'permission-denied';
    }
    expect(defaultClientDenied).toBe(true);

    let missingCode: unknown;
    try {
      await getFirestore(app, 'undeclared-db').doc('rooms/r1').get();
    } catch (err) {
      missingCode = (err as { code?: unknown }).code;
    }
    expect(missingCode).toBe(GrpcStatus.NOT_FOUND);
  });

  test('round-trips cross-database DocumentReference fields, rejects cross-database batches/transactions, and streams per-database onSnapshot updates', async () => {
    const { app, host } = makeArm();
    declareFirestoreDatabase(host, 'reports');
    declareFirestoreDatabase(host, 'archive');

    const reportsDb = getFirestore(app, 'reports');
    const archiveDb = getFirestore(app, 'archive');

    const archiveRef = archiveDb.doc('items/i1');
    await reportsDb.doc('links/l1').set({ target: archiveRef });
    const rawStoredTarget = getDatabaseEnv(host, 'reports').snapshot()['links/l1']?.target as {
      databaseId?: string;
      path?: string;
    };
    expect(rawStoredTarget.databaseId).toBe('archive');
    expect(rawStoredTarget.path).toBe('items/i1');

    const linkSnap = await reportsDb.doc('links/l1').get();
    const readBackRef = linkSnap.get('target') as {
      formattedName: string;
      path: string;
      firestore: unknown;
    };
    expect(readBackRef.path).toBe('items/i1');
    expect(readBackRef.firestore).toBe(reportsDb);
    expect(readBackRef.formattedName).toBe('projects/proj-1/databases/reports/documents/items/i1');

    let batchErr: { code?: unknown; message?: string } | undefined;
    try {
      const crossBatch = reportsDb.batch();
      crossBatch.set(reportsDb.doc('links/uncommitted'), { x: 1 });
      crossBatch.set(archiveRef, { x: 2 });
      await crossBatch.commit();
    } catch (err) {
      batchErr = err as { code?: unknown; message?: string };
    }
    expect(batchErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(batchErr?.message).toContain('archive');
    expect(batchErr?.message).toContain('reports');
    expect((await reportsDb.doc('links/uncommitted').get()).exists).toBe(false);

    let txErr: { code?: unknown; message?: string } | undefined;
    try {
      await reportsDb.runTransaction(async (tx) => {
        await tx.get(archiveRef);
      });
    } catch (err) {
      txErr = err as { code?: unknown; message?: string };
    }
    expect(txErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);

    const seen: Array<Record<string, unknown> | undefined> = [];
    await new Promise<void>((resolve, reject) => {
      const unsub = reportsDb.doc('stream/s1').onSnapshot(
        (snap) => {
          seen.push(snap.data() as Record<string, unknown> | undefined);
          if (seen.length === 2) {
            unsub();
            resolve();
          }
        },
        (err) => {
          unsub();
          reject(err);
        },
      );
      void archiveDb
        .doc('stream/s1')
        .set({ db: 'archive' })
        .then(() => reportsDb.doc('stream/s1').set({ db: 'reports' }));
    });
    expect(seen).toEqual([undefined, { db: 'reports' }]);

    const missingListenerErr = await new Promise<{ code?: unknown; message?: string }>((resolve) => {
      const unsub = getFirestore(app, 'missing-stream')
        .doc('stream/s1')
        .onSnapshot(
          () => undefined,
          (err) => {
            unsub();
            resolve(err as { code?: unknown; message?: string });
          },
        );
    });
    expect(missingListenerErr.code).toBe(GrpcStatus.NOT_FOUND);
    expect(missingListenerErr.message).toContain('The database missing-stream does not exist');
  });

  test('exposes readonly db.databaseId across default, named, initializeFirestore, context, and child handles', () => {
    const { app, host } = makeArm();
    declareFirestoreDatabase(host, 'reports');
    declareFirestoreDatabase(host, 'archive');
    const defaultApp = initializeApp({ sandbox: app.sandbox, projectId: 'proj-1' });

    const defaultDb: AdminFirestore = getFirestore(app);
    const reportsDb: AdminFirestore = getFirestore(app, 'reports');
    const archiveDb: AdminFirestore = initializeFirestore(defaultApp, { preferRest: true }, 'archive');
    const ctxReportsDb: AdminFirestore = getFirestore(app.sandbox.withAuth(null), 'reports');
    const adminReportsDb: AdminFirestore = getAdminFirestore(app.sandbox, 'reports');

    expect(defaultDb.databaseId).toBe('(default)');
    expect(getFirestore(app, '').databaseId).toBe('(default)');
    expect(getFirestore(app, '(default)').databaseId).toBe('(default)');
    expect(reportsDb.databaseId).toBe('reports');
    expect(getFirestore('archive').databaseId).toBe('archive');
    expect(archiveDb.databaseId).toBe('archive');
    expect(ctxReportsDb.databaseId).toBe('reports');
    expect(adminReportsDb.databaseId).toBe('reports');

    expect('databaseId' in defaultDb).toBe(true);
    expect('databaseId' in reportsDb).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(reportsDb, 'databaseId');
    expect(descriptor?.value).toBe('reports');
    expect(descriptor?.writable).toBe(false);

    expect((reportsDb.doc('items/i1').firestore as AdminFirestore).databaseId).toBe('reports');
    expect((reportsDb.collection('items').firestore as AdminFirestore).databaseId).toBe('reports');
    expect((reportsDb.collection('items').where('v', '==', 1).firestore as AdminFirestore).databaseId).toBe('reports');
  });

  test('replays committed oracle observation firestore-named-database-admin-mixing', async () => {
    const observation = load('firestore-named-database-admin-mixing');
    const { app, host } = makeArm();
    declareFirestoreDatabase(host, 'probes');
    const mixingApp = initializeApp(
      { sandbox: app.sandbox, projectId: observation.projectId },
      `oracle-mixing-${_armName}`,
    );

    const defaultDb = getFirestore(mixingApp);
    const probesDb = getFirestore(mixingApp, 'probes');
    expect(defaultDb.databaseId).toBe('(default)');
    expect(probesDb.databaseId).toBe('probes');

    const targetPath = observation.diagnostics.stored.referenceReadBack.path;
    const holderPath = targetPath.replace(/\/target$/, '/holder');
    const batchPath = targetPath.replace(/\/target$/, '/batch');
    const txPath = targetPath.replace(/\/target$/, '/tx');

    await probesDb.doc(targetPath).set({ from: 'probes' });
    const probesTargetRef = probesDb.doc(targetPath);

    // 1. Reference field pointing at `probes` commits inside `(default)`.
    await defaultDb.doc(holderPath).set({ ref: probesTargetRef });
    expect('committed').toBe(observation.behavior['reference-to-other-database']);

    const rawStored = getDatabaseEnv(host, '(default)').snapshot()[holderPath]?.ref as {
      databaseId?: string;
      path?: string;
    };
    expect(`projects/${observation.projectId}/databases/${rawStored.databaseId}/documents/${rawStored.path}`).toBe(
      observation.diagnostics.stored.referenceValueOnTheWire,
    );

    const holderSnap = await defaultDb.doc(holderPath).get();
    const readBackRef = holderSnap.get('ref') as {
      path: string;
      firestore: AdminFirestore;
    };
    expect({
      path: readBackRef.path,
      databaseId: readBackRef.firestore.databaseId,
    }).toEqual(observation.diagnostics.stored.referenceReadBack);

    // 2. WriteBatch spanning `(default)` and `probes` fails with INVALID_ARGUMENT and writes nothing.
    let batchOutcome = 'committed';
    try {
      const batch = defaultDb.batch();
      batch.set(defaultDb.doc(batchPath), { from: 'default' });
      batch.set(probesDb.doc(batchPath), { from: 'probes' });
      await batch.commit();
    } catch (err) {
      const grpcErr = err as { code?: unknown; message?: string };
      batchOutcome = `error:${String(grpcErr.code)}:${String(grpcErr.message)}`;
    }
    expect(batchOutcome).toBe(observation.behavior['batch-spanning-databases']);
    expect({
      default: (await defaultDb.doc(batchPath).get()).exists ? 'exists' : null,
      probes: (await probesDb.doc(batchPath).get()).exists ? 'exists' : null,
    }).toEqual(observation.diagnostics.stored.batch);

    // 3. Transaction on `(default)` reading and writing `probes` fails with INVALID_ARGUMENT and writes nothing.
    let txOutcome = 'committed';
    try {
      await defaultDb.runTransaction(
        async (tx) => {
          await tx.get(probesTargetRef);
          tx.set(defaultDb.doc(txPath), { from: 'default' });
          tx.set(probesDb.doc(txPath), { from: 'probes' });
        },
        { maxAttempts: 1 },
      );
    } catch (err) {
      const grpcErr = err as { code?: unknown; message?: string };
      txOutcome = `error:${String(grpcErr.code)}:${String(grpcErr.message)}`;
    }
    expect(txOutcome).toBe(observation.behavior['transaction-reads-and-writes-other-database']);
    expect({
      default: (await defaultDb.doc(txPath).get()).exists ? 'exists' : null,
      probes: (await probesDb.doc(txPath).get()).exists ? 'exists' : null,
    }).toEqual(observation.diagnostics.stored.transaction);
  });
});
