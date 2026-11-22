import { afterEach, describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  DOC_VALUE_ENCODING,
  encodeDocValue,
  rehydrateDocValue,
} from 'pyric/firestore/internal/value-codec';
import { Reference as InternalReference } from 'pyric/rules/internal';
import {
  initializeSandbox,
  REMOTE_SANDBOX,
  SandboxContextImpl,
  SandboxError,
  type AuthState,
  type RemoteSandbox,
  type Sandbox,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  declareAdminSandboxDatabase,
  isAdminSandboxDatabaseDeclared,
  resolveAdminSandboxDatabaseEnv,
} from '../../src/firestore/admin-named-databases.js';
import {
  getAdminFirestore,
  getFirestore,
  GrpcStatus,
  initializeFirestore,
  onSnapshot,
  type DocumentReference,
} from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

async function captureError(fn: () => unknown): Promise<Error & { code?: unknown; details?: unknown }> {
  try {
    await fn();
  } catch (err) {
    return err as Error & { code?: unknown; details?: unknown };
  }
  throw new Error('Expected operation to throw, but it succeeded.');
}

interface FakeWireHostOptions {
  readonly workerProtocol?: number;
  readonly omitGetVersionProtocol?: boolean;
  readonly declared?: readonly string[];
}

function createFakeRemoteSandbox(
  hostSandbox: Sandbox,
  options: FakeWireHostOptions,
): {
  readonly remote: RemoteSandbox;
  readonly sentOps: Array<Record<string, unknown>>;
  readonly sentSubs: Array<Record<string, unknown>>;
} {
  const sentOps: Array<Record<string, unknown>> = [];
  const sentSubs: Array<Record<string, unknown>> = [];
  for (const id of options.declared ?? []) {
    declareAdminSandboxDatabase(hostSandbox, id);
  }

  const remote = {
    [REMOTE_SANDBOX]: true as const,
    serveUrl: 'http://localhost:5000',
    channel: {
      async op(payload: { method: string } & Record<string, unknown>): Promise<unknown> {
        sentOps.push(payload);
        if (payload.method === 'getRuntimeEpoch') {
          const epochReply: Record<string, unknown> = { version: 'dev' };
          if (options.workerProtocol !== undefined) {
            epochReply.workerProtocol = options.workerProtocol;
          }
          return epochReply;
        }
        if (payload.method === 'getVersion') {
          const baseReply: Record<string, unknown> = { version: 'dev' };
          if (!options.omitGetVersionProtocol) {
            baseReply.instanceId = 'fake-host-1';
            if (options.workerProtocol !== undefined) {
              baseReply.workerProtocol = options.workerProtocol;
            }
          }
          return baseReply;
        }
        const dbId = typeof payload.databaseId === 'string' ? payload.databaseId : '(default)';
        if (dbId !== '(default)' && !isAdminSandboxDatabaseDeclared(hostSandbox, dbId)) {
          const err = new Error(
            `The database ${dbId} does not exist for project demo-project ` +
              'Please visit https://console.cloud.google.com/datastore/setup?project=demo-project ' +
              'to add a Cloud Datastore or Cloud Firestore database. ',
          ) as Error & { code: string };
          err.code = 'not-found';
          throw err;
        }
        const hostDb = getAdminFirestore(hostSandbox, dbId);
        if (payload.method === 'getDoc') {
          const snap = await hostDb.doc(String(payload.path)).get();
          if (!snap.exists) {
            return { exists: false, data: null };
          }
          const env = resolveAdminSandboxDatabaseEnv(hostSandbox, dbId);
          const rawDoc = env.snapshot()[String(payload.path)] ?? {};
          return {
            exists: true,
            data: {
              json: JSON.stringify(encodeDocValue(rawDoc)),
              valueEncoding: DOC_VALUE_ENCODING,
            },
          };
        }
        if (payload.method === 'setDoc') {
          const hydrated = rehydrateDocValue(payload.data) as Record<string, unknown>;
          const env = resolveAdminSandboxDatabaseEnv(hostSandbox, dbId);
          env.adminSetDocument(String(payload.path), hydrated);
          return null;
        }
        if (payload.method === 'admin.readState') {
          const env = resolveAdminSandboxDatabaseEnv(hostSandbox, dbId);
          return env.snapshot();
        }
        throw new Error(`Unsupported fake remote op: ${payload.method}`);
      },
      subscribe(
        sub: { target: unknown } & Record<string, unknown>,
        onSnap: (v: unknown) => void,
        onError?: (err: Error & { code: string }) => void,
      ) {
        sentSubs.push(sub);
        const target = sub.target as { path?: string; databaseId?: string };
        let dbId = '(default)';
        if (typeof target.databaseId === 'string') {
          dbId = target.databaseId;
        }
        if (dbId !== '(default)' && !isAdminSandboxDatabaseDeclared(hostSandbox, dbId)) {
          queueMicrotask(() => {
            if (onError !== undefined) {
              const err = new Error(
                `The database ${dbId} does not exist for project demo-project ` +
                  'Please visit https://console.cloud.google.com/datastore/setup?project=demo-project ' +
                  'to add a Cloud Datastore or Cloud Firestore database. ',
              ) as Error & { code: string };
              err.code = 'not-found';
              onError(err);
            }
          });
          return () => undefined;
        }
        const env = resolveAdminSandboxDatabaseEnv(hostSandbox, dbId);
        let docData: Record<string, unknown> | undefined;
        if (target.path !== undefined) {
          docData = env.snapshot()[target.path];
        }
        queueMicrotask(() => {
          let wireData: { json: string; valueEncoding: typeof DOC_VALUE_ENCODING } | null = null;
          if (docData !== undefined) {
            wireData = {
              json: JSON.stringify(encodeDocValue(docData)),
              valueEncoding: DOC_VALUE_ENCODING,
            };
          }
          const fullPath = target.path ?? '';
          const segments = fullPath.split('/');
          const docId = segments[segments.length - 1] ?? '';
          onSnap({
            id: docId,
            path: fullPath,
            exists: docData !== undefined,
            data: wireData,
          });
        });
        return () => undefined;
      },
    },
    withAuth(auth: AuthState) {
      return new SandboxContextImpl(remote, auth);
    },
  } as unknown as RemoteSandbox;

  return { remote, sentOps, sentSubs };
}

describe('pyric-admin/firestore named databases (ADR-0021 #1320)', () => {
  it('supports getFirestore(app, id), getFirestore(id), initializeFirestore(app, settings, id), and formattedName', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-alpha' });
    declareAdminSandboxDatabase(sandbox, 'reports');
    declareAdminSandboxDatabase(sandbox, 'archive');
    const app = initializeApp({ sandbox, projectId: 'proj-alpha' });

    const defaultDb = getFirestore();
    expect(getFirestore(app)).toBe(defaultDb);
    expect(getFirestore(app, '')).toBe(defaultDb);
    expect(getFirestore(app, '(default)')).toBe(defaultDb);
    expect(getFirestore('')).toBe(defaultDb);
    expect(getFirestore('(default)')).toBe(defaultDb);

    const reportsByApp = getFirestore(app, 'reports');
    const reportsByDefaultApp = getFirestore('reports');
    expect(reportsByApp).toBe(reportsByDefaultApp);
    expect(reportsByApp).not.toBe(defaultDb);

    const archiveDb = initializeFirestore(
      app,
      { ignoreUndefinedProperties: true, preferRest: true },
      'archive',
    );
    expect(getFirestore(app, 'archive')).toBe(archiveDb);
    expect(initializeFirestore(app, { preferRest: true }, 'archive')).toBe(archiveDb);
    const mismatchErr = await captureError(() =>
      initializeFirestore(app, { preferRest: false }, 'archive'),
    );
    expect(mismatchErr.code).toBe(GrpcStatus.FAILED_PRECONDITION);

    expect(
      (defaultDb.doc('users/alice') as unknown as { formattedName: string }).formattedName,
    ).toBe('projects/proj-alpha/databases/(default)/documents/users/alice');
    expect(
      (reportsByApp.doc('users/alice') as unknown as { formattedName: string }).formattedName,
    ).toBe('projects/proj-alpha/databases/reports/documents/users/alice');

    await defaultDb.doc('items/shared').set({ source: 'default' });
    await reportsByApp.doc('items/shared').set({ source: 'reports' });
    await archiveDb.doc('items/shared').set({
      source: 'archive',
      ignored: undefined,
    } as Record<string, unknown>);

    expect((await defaultDb.doc('items/shared').get()).data()).toEqual({ source: 'default' });
    expect((await reportsByApp.doc('items/shared').get()).data()).toEqual({ source: 'reports' });
    expect((await archiveDb.doc('items/shared').get()).data()).toEqual({ source: 'archive' });

    expect((await defaultDb.listCollections()).map((c) => c.id)).toEqual(['items']);
    expect((await reportsByApp.listCollections()).map((c) => c.id)).toEqual(['items']);

    const bundleBuf = reportsByApp
      .bundle('reports-b1')
      .add(await reportsByApp.doc('items/shared').get())
      .build();
    expect(bundleBuf.toString('utf8')).toContain(
      'projects/proj-alpha/databases/reports/documents/items/shared',
    );

    sandbox.reset();
    expect((await defaultDb.doc('items/shared').get()).exists).toBe(false);
    expect((await reportsByApp.doc('items/shared').get()).exists).toBe(false);
    await reportsByApp.doc('items/after-reset').set({ ok: true });
    expect((await reportsByApp.doc('items/after-reset').get()).data()).toEqual({ ok: true });
  });

  it('enforces C3 NOT_FOUND on undeclared databases (including "default" and "Bad_Id") without allocating, and works once declared later', async () => {
    const sandbox = initializeSandbox({ projectId: 'digame-mas' });
    const app = initializeApp({ sandbox, projectId: 'digame-mas' }, 'c3-app');

    for (const missingId of ['undeclared-db', 'Bad_Id', 'default']) {
      const missingDb = getFirestore(app, missingId);
      const ref = missingDb.doc('items/one');
      expect(isAdminSandboxDatabaseDeclared(sandbox, missingId)).toBe(false);

      const expectedDetails =
        `The database ${missingId} does not exist for project digame-mas ` +
        'Please visit https://console.cloud.google.com/datastore/setup?project=digame-mas ' +
        'to add a Cloud Datastore or Cloud Firestore database. ';
      const expectedMessage = `5 NOT_FOUND: ${expectedDetails}`;

      const getErr = await captureError(() => ref.get());
      expect(getErr.code).toBe(GrpcStatus.NOT_FOUND);
      expect(getErr.details).toBe(expectedDetails);
      expect(getErr.message).toBe(expectedMessage);

      const setErr = await captureError(() => ref.set({ v: 1 }));
      expect(setErr.code).toBe(GrpcStatus.NOT_FOUND);
      expect(setErr.message).toBe(expectedMessage);

      const queryErr = await captureError(() => missingDb.collection('items').get());
      expect(queryErr.code).toBe(GrpcStatus.NOT_FOUND);

      const countErr = await captureError(() => missingDb.collection('items').count().get());
      expect(countErr.code).toBe(GrpcStatus.NOT_FOUND);
    }

    // Late declaration after handle + ref creation must succeed dynamically.
    const lateDb = getFirestore(app, 'late-reports');
    const lateRef = lateDb.doc('items/late');
    const lateQuery = lateDb.collection('items').where('v', '==', 7);
    const beforeDecl = await captureError(() => lateRef.get());
    expect(beforeDecl.code).toBe(GrpcStatus.NOT_FOUND);

    declareAdminSandboxDatabase(sandbox, 'late-reports');
    await lateRef.set({ v: 7 });
    expect((await lateRef.get()).data()).toEqual({ v: 7 });
    expect((await lateQuery.get()).docs.map((d) => d.id)).toEqual(['late']);
  });

  it('scopes getFirestore(ctx, databaseId) rules and update() existence checks to the named database', async () => {
    const sandbox = initializeSandbox({ projectId: 'ctx-proj' });
    declareAdminSandboxDatabase(sandbox, 'reports');

    const defaultAdmin = getAdminFirestore(sandbox);
    const reportsAdmin = getAdminFirestore(sandbox, 'reports');
    await defaultAdmin.doc('docs/only-default').set({ v: 1 });
    await reportsAdmin.doc('docs/only-reports').set({ v: 2 });

    const aliceCtx = sandbox.withAuth({ uid: 'alice' });
    const reportsAlice = getFirestore(aliceCtx, 'reports');
    reportsAlice.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read, write: if request.auth != null && request.auth.uid == 'alice';
    }
  }
}`);

    // `docs/only-default` exists in (default) only -> update() on `reports` must fail `not-found` (not permission-denied).
    const missingInReports = await captureError(() =>
      reportsAlice.doc('docs/only-default').update({ v: 99 }),
    );
    expect(missingInReports).toBeInstanceOf(SandboxError);
    expect(missingInReports.code).toBe('not-found');

    await reportsAlice.doc('docs/only-reports').update({ v: 20 });
    expect((await reportsAdmin.doc('docs/only-reports').get()).data()).toEqual({ v: 20 });
  });

  it('matches C4 Admin database mixing: stores cross-db DocumentReference with databaseId while rejecting cross-db WriteBatch, Transaction, getAll, recursiveDelete, and BulkWriter', async () => {
    const sandbox = initializeSandbox({ projectId: 'digame-mas' });
    declareAdminSandboxDatabase(sandbox, 'probes');
    const app = initializeApp({ sandbox, projectId: 'digame-mas' }, 'c4-app');

    const defaultDb = getFirestore(app);
    const probesDb = getFirestore(app, 'probes');

    await probesDb.doc('c4/target').set({ v: 'probes' });
    const probesTarget = probesDb.doc('c4/target');

    // 1. Cross-db reference field commits, stores `probes` databaseId on InternalReference,
    // and resolves against reading handle (`defaultDb`) on read-back.
    await defaultDb.doc('c4/holder').set({ ref: probesTarget });
    const rawStored = getInternalEnv(sandbox).snapshot()['c4/holder']?.ref;
    expect(rawStored).toBeInstanceOf(InternalReference);
    expect((rawStored as InternalReference).databaseId).toBe('probes');
    expect((rawStored as InternalReference).path).toBe('c4/target');

    const holderSnap = await defaultDb.doc('c4/holder').get();
    const readBackRef = holderSnap.get('ref') as DocumentReference;
    expect(readBackRef.path).toBe('c4/target');
    expect(readBackRef.firestore).toBe(defaultDb);
    expect(
      (readBackRef as unknown as { formattedName: string }).formattedName,
    ).toBe('projects/digame-mas/databases/(default)/documents/c4/target');

    const expectedCrossDetails =
      "The request was for database 'projects/digame-mas/databases/(default)' " +
      "but was attempting to access database 'projects/digame-mas/databases/probes'";
    const expectedCrossMessage = `3 INVALID_ARGUMENT: ${expectedCrossDetails}`;

    // 2. WriteBatch spanning databases does NOT throw at .set(), rejects at .commit() with code 3, writes nothing.
    const batch = defaultDb.batch();
    batch.set(defaultDb.doc('c4/batch'), { v: 'default' });
    batch.set(probesDb.doc('c4/batch'), { v: 'probes' });
    const batchErr = await captureError(() => batch.commit());
    expect(batchErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(batchErr.details).toBe(expectedCrossDetails);
    expect(batchErr.message).toBe(expectedCrossMessage);
    expect((await defaultDb.doc('c4/batch').get()).exists).toBe(false);
    expect((await probesDb.doc('c4/batch').get()).exists).toBe(false);

    // 3a. Transaction reading another database rejects with code 3 and writes nothing.
    const txReadErr = await captureError(() =>
      defaultDb.runTransaction(
        async (tx) => {
          await tx.get(probesTarget);
          tx.set(defaultDb.doc('c4/tx-read'), { v: 'default' });
        },
        { maxAttempts: 1 },
      ),
    );
    expect(txReadErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(txReadErr.message).toBe(expectedCrossMessage);
    expect((await defaultDb.doc('c4/tx-read').get()).exists).toBe(false);

    // 3b. Transaction writing to another database without reading rejects at commit with code 3 and writes nothing.
    const txWriteErr = await captureError(() =>
      defaultDb.runTransaction(
        async (tx) => {
          tx.set(defaultDb.doc('c4/tx-write'), { v: 'default' });
          tx.set(probesDb.doc('c4/tx-write'), { v: 'probes' });
        },
        { maxAttempts: 1 },
      ),
    );
    expect(txWriteErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(txWriteErr.message).toBe(expectedCrossMessage);
    expect((await defaultDb.doc('c4/tx-write').get()).exists).toBe(false);
    expect((await probesDb.doc('c4/tx-write').get()).exists).toBe(false);

    // 4. getAll, recursiveDelete, and BulkWriter also reject cross-database references with code 3.
    const getAllErr = await captureError(() => defaultDb.getAll(probesTarget));
    expect(getAllErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);

    const recDelErr = await captureError(() => defaultDb.recursiveDelete(probesTarget));
    expect(recDelErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);

    const seenBwCodes: number[] = [];
    const bw = defaultDb.bulkWriter();
    bw.onWriteError((e) => {
      seenBwCodes.push(e.code);
      return false;
    });
    const bwErr = await captureError(() => bw.set(probesTarget, { v: 'wrong' }));
    await bw.close();
    expect(bwErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(seenBwCodes).toEqual([GrpcStatus.INVALID_ARGUMENT as number]);
  });

  it('refuses protocol-1 remote hosts on first named-db op with FirebaseError("failed-precondition") and routes databaseId on protocol-2 hosts', async () => {
    const hostV1 = initializeSandbox({ projectId: 'demo-project' });
    const v1 = createFakeRemoteSandbox(hostV1, { declared: ['reports'] });
    const appV1 = initializeApp(
      { sandbox: v1.remote, projectId: 'demo-project' },
      'remote-v1',
    );

    // `(default)` works against protocol-1 without waiting for or failing on workerProtocol.
    const defV1 = getFirestore(appV1);
    await defV1.doc('items/d1').set({ ok: true });
    expect((await defV1.doc('items/d1').get()).data()).toEqual({ ok: true });
    expect(v1.sentOps.some((op) => op.method === 'getRuntimeEpoch' || op.method === 'getVersion')).toBe(false);

    // Named handle constructs synchronously; first op probes getVersion and fails with FirebaseError('failed-precondition').
    const namedV1 = getFirestore(appV1, 'reports');
    expect(v1.sentOps.filter((op) => op.databaseId === 'reports')).toHaveLength(0);

    const refusal = await captureError(() => namedV1.doc('items/r1').get());
    expect(refusal).toBeInstanceOf(FirebaseError);
    expect(refusal.code).toBe('failed-precondition');
    expect(refusal.message).toBe(
      'pyric: the host at http://localhost:5000 speaks worker protocol 1, which has no Firestore database ids. ' +
        'Restart it with @pyric/cli 0.1.0-alpha.35 or later to use getFirestore(app, "reports").',
    );
    expect(v1.sentOps.filter((op) => op.method === 'getDoc' && op.databaseId === 'reports')).toHaveLength(0);

    // Against protocol-2 host, named ops stamp `databaseId`, undeclared fails C3 code 5, and cross-db refs preserve databaseId on wire.
    const hostV2 = initializeSandbox({ projectId: 'demo-project' });
    const v2 = createFakeRemoteSandbox(hostV2, {
      workerProtocol: 2,
      declared: ['reports', 'probes'],
    });
    const appV2 = initializeApp(
      { sandbox: v2.remote, projectId: 'demo-project' },
      'remote-v2',
    );

    const defV2 = getFirestore(appV2);
    const reportsV2 = getFirestore(appV2, 'reports');
    const probesV2 = getFirestore(appV2, 'probes');
    const missingV2 = getFirestore(appV2, 'missing-db');

    await defV2.doc('items/shared').set({ plane: 'default' });
    await reportsV2.doc('items/shared').set({ plane: 'reports', target: probesV2.doc('p/1') });

    expect((await defV2.doc('items/shared').get()).data()).toEqual({ plane: 'default' });
    const repSnap = await reportsV2.doc('items/shared').get();
    expect(repSnap.get('plane')).toBe('reports');
    const repRef = repSnap.get('target') as DocumentReference;
    expect(repRef.path).toBe('p/1');
    expect(repRef.firestore).toBe(reportsV2);

    const hostReportsDoc = resolveAdminSandboxDatabaseEnv(hostV2, 'reports').snapshot()['items/shared'];
    expect((hostReportsDoc?.target as InternalReference).databaseId).toBe('probes');

    const missingRemoteErr = await captureError(() => missingV2.doc('items/x').get());
    expect(missingRemoteErr.code).toBe(GrpcStatus.NOT_FOUND);

    const snaps: Array<Record<string, unknown> | undefined> = [];
    const unsub = onSnapshot(reportsV2.doc('items/shared'), (s) => {
      snaps.push(s.data());
    });
    await new Promise((r) => setTimeout(r, 20));
    unsub();
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(
      v2.sentSubs.some(
        (s) => (s.target as { databaseId?: string }).databaseId === 'reports',
      ),
    ).toBe(true);

    // Host without `instanceId` omits `workerProtocol` on `getVersion` but reports `workerProtocol: 2` on `getRuntimeEpoch`.
    const v2NoInst = createFakeRemoteSandbox(hostV2, { workerProtocol: 2, omitGetVersionProtocol: true });
    const appNoInst = initializeApp({ sandbox: v2NoInst.remote, projectId: 'demo-project' }, 'remote-v2-no-inst');
    expect((await getFirestore(appNoInst, 'reports').doc('items/shared').get()).get('plane')).toBe('reports');
    expect(v2NoInst.sentOps[0]?.method).toBe('getRuntimeEpoch');
  });

  it('delivers C3 5 NOT_FOUND to onSnapshot onError on undeclared in-process databases, suppresses on immediate unsub, and rebinds late-declared listener/tx queries', async () => {
    const sandbox = initializeSandbox({ projectId: 'digame-mas' });
    const app = initializeApp({ sandbox, projectId: 'digame-mas' }, 'c3-listeners-and-tx');
    const ghostDb = getFirestore(app, 'ghost');

    const seenNext: unknown[] = [];
    const seenErr: Array<Error & { code?: unknown; details?: unknown }> = [];
    const unsubActive = ghostDb.doc('items/one').onSnapshot(
      (snap) => seenNext.push(snap),
      (err) => seenErr.push(err as Error & { code?: unknown; details?: unknown }),
    );
    const suppressedErr: unknown[] = [];
    const unsubCancelled = ghostDb.doc('items/two').onSnapshot(
      () => undefined,
      (err) => suppressedErr.push(err),
    );
    unsubCancelled();

    await new Promise((r) => setTimeout(r, 20));
    unsubActive();

    expect(seenNext).toEqual([]);
    expect(suppressedErr).toEqual([]);
    expect(seenErr).toHaveLength(1);
    expect(seenErr[0]!.code).toBe(GrpcStatus.NOT_FOUND);
    const expectedDetails =
      'The database ghost does not exist for project digame-mas ' +
      'Please visit https://console.cloud.google.com/datastore/setup?project=digame-mas ' +
      'to add a Cloud Datastore or Cloud Firestore database. ';
    expect(seenErr[0]!.details).toBe(expectedDetails);
    expect(seenErr[0]!.message).toBe(`5 NOT_FOUND: ${expectedDetails}`);

    // Late-declared handle: query + docRef constructed BEFORE declaration must rebind inside runTransaction & onSnapshot.
    const lateDb = getFirestore(app, 'late-reports');
    const lateDocRef = lateDb.doc('items/late');
    const lateQuery = lateDb.collection('items').where('v', '==', 7);

    declareAdminSandboxDatabase(sandbox, 'late-reports');
    await lateDb.doc('items/late').set({ v: 7 });

    const txResult = await lateDb.runTransaction(async (tx) => {
      const qSnap = await tx.get(lateQuery);
      const dSnap = await tx.get(lateDocRef);
      return {
        ids: qSnap.docs.map((d) => d.id),
        docVal: dSnap.data()?.v,
      };
    });
    expect(txResult).toEqual({ ids: ['late'], docVal: 7 });

    const lateQueryDocs: string[][] = [];
    const unsubLate = lateQuery.onSnapshot((qs) => {
      lateQueryDocs.push(qs.docs.map((d) => d.id));
    });
    await new Promise((r) => setTimeout(r, 20));
    unsubLate();
    expect(lateQueryDocs[0]).toEqual(['late']);
  });

  it('aligns remote C3 NOT_FOUND projectId with app.options.projectId and guards > 256-char databaseIds before wire send', async () => {
    const host = initializeSandbox({ projectId: 'demo-project' });
    const v2 = createFakeRemoteSandbox(host, {
      workerProtocol: 2,
      declared: ['reports'],
    });
    const customApp = initializeApp(
      { sandbox: v2.remote, projectId: 'custom-proj' },
      'remote-custom-proj',
    );

    const missingRemote = getFirestore(customApp, 'missing-db');
    const missingErr = await captureError(() => missingRemote.doc('items/x').get());
    const expectedMissingDetails =
      'The database missing-db does not exist for project custom-proj ' +
      'Please visit https://console.cloud.google.com/datastore/setup?project=custom-proj ' +
      'to add a Cloud Datastore or Cloud Firestore database. ';
    expect(missingErr.code).toBe(GrpcStatus.NOT_FOUND);
    expect(missingErr.details).toBe(expectedMissingDetails);
    expect(missingErr.message).toBe(`5 NOT_FOUND: ${expectedMissingDetails}`);

    const longId = 'a'.repeat(300);
    const overlongRemote = getFirestore(customApp, longId);
    const opsBefore = v2.sentOps.length;
    const overlongErr = await captureError(() => overlongRemote.doc('items/x').get());
    const expectedLongDetails =
      `The database ${longId} does not exist for project custom-proj ` +
      'Please visit https://console.cloud.google.com/datastore/setup?project=custom-proj ' +
      'to add a Cloud Datastore or Cloud Firestore database. ';
    expect(overlongErr.code).toBe(GrpcStatus.NOT_FOUND);
    expect(overlongErr.details).toBe(expectedLongDetails);
    expect(overlongErr.message).toBe(`5 NOT_FOUND: ${expectedLongDetails}`);
    // Only getVersion (at most once) may have been sent; getDoc with 300-char databaseId must NOT cross the wire.
    expect(
      v2.sentOps.slice(opsBefore).some((op) => op.method === 'getDoc'),
    ).toBe(false);
  });
});
