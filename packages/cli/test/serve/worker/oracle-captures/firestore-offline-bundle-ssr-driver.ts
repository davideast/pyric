import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  applySettingsCacheMode,
  assertAndRecordAppFirestoreSettings,
  clearAppFirestoreSettings,
  recordImplicitAppFirestoreSettings,
} from 'pyric/firestore/internal';
import type { Behavior } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import * as surface from '../../../../src/serve/entries/firestore-surface.js';
import {
  clearIndexedDbPersistence as workerClearIndexedDbPersistence,
  documentSnapshotFromJSON as workerDocumentSnapshotFromJSON,
  loadBundle as workerLoadBundle,
  namedQuery as workerNamedQuery,
  onSnapshotResume as workerOnSnapshotResume,
  querySnapshotFromJSON as workerQuerySnapshotFromJSON,
} from '../../../../src/serve/worker/client/firestore-bundles-ssr.js';
import {
  registerWorkerDbTeardown,
  terminate as workerTerminate,
} from '../../../../src/serve/worker/client/firestore-lifecycle.js';
import { readDocumentAs, readQueryAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { disableNetwork as workerDisableNetwork } from '../../../../src/serve/worker/client/firestore-network.js';
import * as workerClient from '../../../../src/serve/worker/index.js';

export interface BundlePlaneDriver {
  getFirestore(app: FirebaseApp, databaseId?: string): unknown;
  initializeFirestore(app: FirebaseApp, settings?: surface.FirestoreSettings, databaseId?: string): unknown;
  disableNetwork(db: unknown): Promise<void>;
  terminate(db: unknown): Promise<void>;
  clearIndexedDbPersistence(db: unknown): Promise<void>;
  doc(parent: unknown, path: string): unknown;
  loadBundle(db: unknown, data: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string): surface.LoadBundleTask;
  namedQuery(db: unknown, name: string): Promise<unknown>;
  getDocFromCache(ref: unknown): Promise<{ exists(): boolean; id: string; ref: { path: string }; metadata: { fromCache: boolean; hasPendingWrites: boolean }; data(): Record<string, unknown> | undefined; get(field: string): unknown; toJSON(): object }>;
  getDocsFromCache(q: unknown): Promise<{ size: number; empty: boolean; metadata: { fromCache: boolean; hasPendingWrites: boolean }; docs: Array<{ id: string; ref: { path: string }; data(): Record<string, unknown> }>; toJSON(): object }>;
  documentSnapshotFromJSON(db: unknown, json: object): { exists(): boolean; id: string; ref: { path: string }; metadata: { fromCache: boolean; hasPendingWrites: boolean }; data(): Record<string, unknown> | undefined; get(field: string): unknown };
  querySnapshotFromJSON(db: unknown, json: object): { size: number; empty: boolean; metadata: { fromCache: boolean; hasPendingWrites: boolean }; docs: Array<{ id: string; ref: { path: string }; data(): Record<string, unknown> }> };
  onSnapshotResume(db: unknown, json: object, ...args: unknown[]): () => void;
}
interface ObservedCallOutcome { threw: boolean; threwSynchronously: boolean; code: string | null; errorName: string | null; isFirestoreError: boolean; isFirebaseError: boolean; }
interface ObservedProgressStep { taskState: string; documentsLoaded: number; totalDocuments: number; bytesLoaded: number; totalBytes: number; }

function noErrorOutcome(): ObservedCallOutcome {
  return { threw: false, threwSynchronously: false, code: null, errorName: null, isFirestoreError: false, isFirebaseError: false };
}

function errorOutcomeOf(err: unknown, threwSynchronously: boolean): ObservedCallOutcome {
  let code: string | null = null;
  let errorName: string | null = null;
  if (err !== null && typeof err === 'object') {
    const record = err as { code?: unknown; name?: unknown };
    if (typeof record.code === 'string') code = record.code;
    if (typeof record.name === 'string') errorName = record.name;
  }
  return { threw: true, threwSynchronously, code, errorName, isFirestoreError: err instanceof surface.FirestoreError, isFirebaseError: err instanceof FirebaseError };
}
function observeSyncThrow(fn: () => unknown): ObservedCallOutcome {
  try { fn(); return noErrorOutcome(); } catch (err) { return errorOutcomeOf(err, true); }
}
async function observeAsyncVoidCall(fn: () => Promise<void>): Promise<ObservedCallOutcome & { isPromise: boolean; resolvedUndefined: boolean }> {
  let promiseValue: Promise<void>;
  try { promiseValue = fn(); } catch (err) { return { ...errorOutcomeOf(err, true), isPromise: false, resolvedUndefined: false }; }
  const isPromise = promiseValue instanceof Promise;
  try { const settled = await promiseValue; return { ...noErrorOutcome(), isPromise, resolvedUndefined: settled === undefined }; } catch (err) { return { ...errorOutcomeOf(err, false), isPromise, resolvedUndefined: false }; }
}

function encodeLengthPrefixedElements(elements: readonly unknown[]): string {
  const encoder = new TextEncoder();
  let encoded = '';
  for (const element of elements) {
    const json = JSON.stringify(element);
    encoded += `${encoder.encode(json).byteLength}${json}`;
  }
  return encoded;
}

export function buildSyntheticArticlesBundle(projectId: string): string {
  const parent = `projects/${projectId}/databases/(default)/documents`;
  const alphaName = `${parent}/articles/alpha`;
  const betaName = `${parent}/articles/beta`;
  const ghostName = `${parent}/articles/ghost`;
  const bodyElements = [
    {
      namedQuery: {
        name: 'published-articles',
        readTime: '2026-01-15T12:00:00.000000000Z',
        bundledQuery: {
          parent,
          structuredQuery: {
            from: [{ collectionId: 'articles' }],
            where: { fieldFilter: { field: { fieldPath: 'published' }, op: 'EQUAL', value: { booleanValue: true } } },
            orderBy: [
              { field: { fieldPath: 'rank' }, direction: 'ASCENDING' },
              { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
            ],
          },
          limitType: 'FIRST',
        },
      },
    },
    { documentMetadata: { name: alphaName, readTime: '2026-01-15T12:00:00.000000000Z', exists: true, queries: ['published-articles'] } },
    { document: { name: alphaName, createTime: '2026-01-15T11:00:00.000000000Z', updateTime: '2026-01-15T11:30:00.000000000Z', fields: { title: { stringValue: 'First Post' }, published: { booleanValue: true }, rank: { integerValue: '1' } } } },
    { documentMetadata: { name: betaName, readTime: '2026-01-15T12:00:00.000000000Z', exists: true, queries: [] } },
    { document: { name: betaName, createTime: '2026-01-15T11:05:00.000000000Z', updateTime: '2026-01-15T11:35:00.000000000Z', fields: { title: { stringValue: 'Draft Note' }, published: { booleanValue: false }, rank: { integerValue: '2' } } } },
    { documentMetadata: { name: ghostName, readTime: '2026-01-15T12:00:00.000000000Z', exists: false, queries: [] } },
  ];
  const bodyPayload = encodeLengthPrefixedElements(bodyElements);
  const totalBytes = new TextEncoder().encode(bodyPayload).byteLength;
  const headerPayload = encodeLengthPrefixedElements([
    { metadata: { id: 'articles-bundle-v1', createTime: '2026-01-15T12:00:00.000000000Z', version: 1, totalDocuments: 3, totalBytes } },
  ]);
  return headerPayload + bodyPayload;
}

function toProgressStep(progress: surface.LoadBundleTaskProgress): ObservedProgressStep {
  return {
    taskState: progress.taskState,
    documentsLoaded: progress.documentsLoaded,
    totalDocuments: progress.totalDocuments,
    bytesLoaded: progress.bytesLoaded,
    totalBytes: progress.totalBytes,
  };
}

function extractJsonTypeTag(jsonValue: object): string | null {
  const candidate = jsonValue as { type?: unknown };
  if (typeof candidate.type === 'string') return candidate.type;
  return null;
}

export async function replayWithDriver(driver: BundlePlaneDriver, labelPrefix: string): Promise<Behavior> {
  const bundleProjectId = 'demo-firestore-bundle-ssr-probe';
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error('Unexpected outbound fetch in served offline bundle/SSR replay');
    },
    { preconnect: originalFetch.preconnect },
  );

  if (getApps().length === 0) await resetAppRegistryForTests();
  const existingApp = getApps()[0];
  let appOptions = { apiKey: 'fake-api-key', projectId: bundleProjectId };
  if (existingApp !== undefined) appOptions = existingApp.options as typeof appOptions;

  const apps: FirebaseApp[] = [];
  const activeHandles = new Set<unknown>();
  const activeUnsubs: Array<() => void> = [];
  const openApp = (label: string): FirebaseApp => {
    const app = initializeApp(appOptions, `${labelPrefix}-${label}`);
    apps.push(app);
    return app;
  };
  const openOfflineMemoryDb = async (label: string): Promise<unknown> => {
    const app = openApp(label);
    const db = driver.initializeFirestore(app, { localCache: surface.memoryLocalCache() });
    activeHandles.add(db);
    await driver.disableNetwork(db);
    return db;
  };

  try {
    const bundleString = buildSyntheticArticlesBundle(bundleProjectId);
    const bundleBytes = new TextEncoder().encode(bundleString);
    const bundleArrayBuffer = bundleBytes.buffer.slice(bundleBytes.byteOffset, bundleBytes.byteOffset + bundleBytes.byteLength);

    const dbProducer = await openOfflineMemoryDb('producer');
    const progressEvents: ObservedProgressStep[] = [];
    let onProgressCompleted = false;
    const stringTask = driver.loadBundle(dbProducer, bundleString);
    const isLoadBundleTaskInstance = stringTask instanceof surface.LoadBundleTask;
    stringTask.onProgress((p) => { progressEvents.push(toProgressStep(p)); }, undefined, () => { onProgressCompleted = true; });
    const finalStringProgress = toProgressStep(await stringTask);

    const dbBytes = await openOfflineMemoryDb('uint8');
    const finalBytesProgress = toProgressStep(await driver.loadBundle(dbBytes, bundleBytes));
    const bytesAlphaSnap = await driver.getDocFromCache(driver.doc(dbBytes, 'articles/alpha'));
    const arrayBufferOutcome = observeSyncThrow(() => driver.loadBundle(dbBytes, bundleArrayBuffer));

    let malformedProgressErrorInvoked = false;
    let malformedBundleOutcome: ObservedCallOutcome;
    surface.setLogLevel('silent');
    try {
      const badTask = driver.loadBundle(dbProducer, 'not-a-valid-bundle');
      badTask.onProgress(undefined, () => { malformedProgressErrorInvoked = true; });
      try {
        await badTask;
        malformedBundleOutcome = noErrorOutcome();
      } catch (err) {
        malformedBundleOutcome = errorOutcomeOf(err, false);
      }
    } finally {
      surface.setLogLevel('error');
    }

    const publishedQuery = await driver.namedQuery(dbProducer, 'published-articles');
    const missingNamedQuery = await driver.namedQuery(dbProducer, 'missing-bundle-query');
    if (publishedQuery === null) throw new Error('Expected published-articles namedQuery to resolve to a Query');

    const alphaSnap = await driver.getDocFromCache(driver.doc(dbProducer, 'articles/alpha'));
    const betaSnap = await driver.getDocFromCache(driver.doc(dbProducer, 'articles/beta'));
    const ghostSnap = await driver.getDocFromCache(driver.doc(dbProducer, 'articles/ghost'));
    const publishedQuerySnap = await driver.getDocsFromCache(publishedQuery);

    const alphaJson = alphaSnap.toJSON();
    const ghostJson = ghostSnap.toJSON();
    const queryJson = publishedQuerySnap.toJSON();

    const dbConsumer = await openOfflineMemoryDb('ssr-consumer');
    const hydratedAlpha = driver.documentSnapshotFromJSON(dbConsumer, alphaJson);
    const hydratedMissingDocOutcome = observeSyncThrow(() => driver.documentSnapshotFromJSON(dbConsumer, ghostJson));
    const hydratedQuery = driver.querySnapshotFromJSON(dbConsumer, queryJson);

    let missingDocBundleIsEmpty = false;
    if ((ghostJson as { bundle?: unknown }).bundle === '') missingDocBundleIsEmpty = true;

    const invalidSsrJsonChecks = {
      docFromEmptyObject: observeSyncThrow(() => driver.documentSnapshotFromJSON(dbConsumer, {})),
      docFromQueryJson: observeSyncThrow(() => driver.documentSnapshotFromJSON(dbConsumer, queryJson)),
      queryFromEmptyObject: observeSyncThrow(() => driver.querySnapshotFromJSON(dbConsumer, {})),
      queryFromDocJson: observeSyncThrow(() => driver.querySnapshotFromJSON(dbConsumer, alphaJson)),
    };

    const dbResumeDoc = await openOfflineMemoryDb('resume-doc');
    let unsubDocReturnType = '';
    const resumedDocSnapshot = await new Promise<{
      isDocumentSnapshotInstance: boolean; exists: boolean; id: string; path: string; fromCache: boolean; hasPendingWrites: boolean; data: unknown;
    }>((resolve, reject) => {
      const unsub = driver.onSnapshotResume(
        dbResumeDoc,
        alphaJson,
        (snap: { exists(): boolean; id: string; ref: { path: string }; metadata: { fromCache: boolean; hasPendingWrites: boolean }; data(): unknown }) => {
          resolve({ isDocumentSnapshotInstance: snap instanceof surface.DocumentSnapshot, exists: snap.exists(), id: snap.id, path: snap.ref.path, fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites, data: snap.data() ?? null });
        },
        (err: unknown) => { reject(err); },
      );
      unsubDocReturnType = typeof unsub;
      activeUnsubs.push(unsub);
    });

    const dbResumeQuery = await openOfflineMemoryDb('resume-query');
    let unsubQueryReturnType = '';
    const resumedQuerySnapshot = await new Promise<{
      isQuerySnapshotInstance: boolean; size: number; empty: boolean; fromCache: boolean; hasPendingWrites: boolean; ids: string[]; docsData: unknown[];
    }>((resolve, reject) => {
      const unsub = driver.onSnapshotResume(dbResumeQuery, queryJson, {
        next: (snap: { size: number; empty: boolean; metadata: { fromCache: boolean; hasPendingWrites: boolean }; docs: Array<{ id: string; data(): unknown }> }) => {
          resolve({ isQuerySnapshotInstance: snap instanceof surface.QuerySnapshot, size: snap.size, empty: snap.empty, fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites, ids: snap.docs.map((e) => e.id), docsData: snap.docs.map((e) => e.data()) });
        },
        error: (err: unknown) => { reject(err); },
      });
      unsubQueryReturnType = typeof unsub;
      activeUnsubs.push(unsub);
    });

    const appClearFresh = openApp('clear-fresh');
    const dbClearFresh = driver.getFirestore(appClearFresh);
    activeHandles.add(dbClearFresh);
    const clearBeforeStart = await observeAsyncVoidCall(() => driver.clearIndexedDbPersistence(dbClearFresh));

    const dbClearRunning = await openOfflineMemoryDb('clear-running');
    const clearWhileRunning = await observeAsyncVoidCall(() => driver.clearIndexedDbPersistence(dbClearRunning));
    await driver.terminate(dbClearRunning);
    activeHandles.delete(dbClearRunning);
    const clearAfterTerminate = await observeAsyncVoidCall(() => driver.clearIndexedDbPersistence(dbClearRunning));

    return {
      fetchCalls,
      bundleLoading: {
        isLoadBundleTaskInstance, onProgressCompleted, progressEvents, finalStringProgress, finalBytesProgress,
        uint8AlphaExists: bytesAlphaSnap.exists(), uint8AlphaData: bytesAlphaSnap.data() ?? null,
        arrayBufferOnNodePlatform: arrayBufferOutcome,
        malformedBundle: { ...malformedBundleOutcome, progressErrorInvoked: malformedProgressErrorInvoked },
        cachedDocuments: {
          alpha: { exists: alphaSnap.exists(), id: alphaSnap.id, fromCache: alphaSnap.metadata.fromCache, data: alphaSnap.data() ?? null },
          beta: { exists: betaSnap.exists(), id: betaSnap.id, fromCache: betaSnap.metadata.fromCache, data: betaSnap.data() ?? null },
          ghost: { exists: ghostSnap.exists(), id: ghostSnap.id, fromCache: ghostSnap.metadata.fromCache, dataIsUndefined: ghostSnap.data() === undefined },
        },
        namedQueries: {
          foundIsQueryInstance: publishedQuery instanceof surface.Query, missingQueryIsNull: missingNamedQuery === null,
          publishedQueryResult: { size: publishedQuerySnap.size, empty: publishedQuerySnap.empty, fromCache: publishedQuerySnap.metadata.fromCache, ids: publishedQuerySnap.docs.map((e) => e.id), docsData: publishedQuerySnap.docs.map((e) => e.data()) },
        },
      },
      ssrSnapshotHydration: {
        serializedEnvelope: { docJsonType: extractJsonTypeTag(alphaJson), docJsonKeys: Object.keys(alphaJson).sort(), queryJsonType: extractJsonTypeTag(queryJson), queryJsonKeys: Object.keys(queryJson).sort() },
        hydratedExistingDoc: { isDocumentSnapshotInstance: hydratedAlpha instanceof surface.DocumentSnapshot, exists: hydratedAlpha.exists(), id: hydratedAlpha.id, path: hydratedAlpha.ref.path, fromCache: hydratedAlpha.metadata.fromCache, hasPendingWrites: hydratedAlpha.metadata.hasPendingWrites, data: hydratedAlpha.data() ?? null, titleViaGet: hydratedAlpha.get('title') },
        hydratedMissingDoc: { serializedType: extractJsonTypeTag(ghostJson), serializedBundleIsEmpty: missingDocBundleIsEmpty, fromJsonOutcome: hydratedMissingDocOutcome },
        hydratedQuerySnapshot: { isQuerySnapshotInstance: hydratedQuery instanceof surface.QuerySnapshot, size: hydratedQuery.size, empty: hydratedQuery.empty, fromCache: hydratedQuery.metadata.fromCache, hasPendingWrites: hydratedQuery.metadata.hasPendingWrites, docs: hydratedQuery.docs.map((e) => ({ id: e.id, path: e.ref.path, isQueryDocumentSnapshotInstance: e instanceof surface.QueryDocumentSnapshot, data: e.data() })) },
        resumedDocumentListener: { unsubscribeReturnType: unsubDocReturnType, snapshot: resumedDocSnapshot },
        resumedQueryListener: { unsubscribeReturnType: unsubQueryReturnType, snapshot: resumedQuerySnapshot },
        invalidSsrJsonChecks,
      },
      clearPersistenceLifecycle: { beforeStart: clearBeforeStart, whileRunning: clearWhileRunning, afterTerminate: clearAfterTerminate },
    };
  } finally {
    globalThis.fetch = originalFetch;
    surface.setLogLevel('error');
    for (const unsub of activeUnsubs) unsub();
    for (const handle of activeHandles) await driver.terminate(handle).catch(() => {});
    await Promise.all(apps.map((app) => deleteApp(app)));
  }
}

export function makeWorkerPlaneDriver(openClientForApp: (app: FirebaseApp) => { port: object }): BundlePlaneDriver {
  const byApp = new WeakMap<FirebaseApp, unknown>();
  const driver: BundlePlaneDriver = {
    getFirestore(app: FirebaseApp, databaseId?: string) {
      const existing = byApp.get(app);
      if (existing !== undefined) { recordImplicitAppFirestoreSettings(app, databaseId, existing as object); return existing; }
      const rawClient = openClientForApp(app);
      const handle = { __kind: 'client-db' as const, port: rawClient.port, app, type: 'firestore' as const };
      registerWorkerDbTeardown(handle, () => {
        byApp.delete(app);
        clearAppFirestoreSettings(app);
      });
      byApp.set(app, handle);
      recordImplicitAppFirestoreSettings(app, databaseId, handle);
      return handle;
    },
    initializeFirestore(app: FirebaseApp, settings?: surface.FirestoreSettings, databaseId?: string) {
      assertAndRecordAppFirestoreSettings(app, settings, databaseId);
      const handle = driver.getFirestore(app, databaseId) as object;
      applySettingsCacheMode(handle, settings, databaseId, app);
      return handle;
    },
    async disableNetwork(db) {
      await workerDisableNetwork(db as never);
    },
    async terminate(db) {
      await workerTerminate(db as never);
    },
    clearIndexedDbPersistence: (db) => workerClearIndexedDbPersistence(db as never),
    doc: (parent, path) => workerClient.doc(parent as never, path),
    loadBundle: (db, data) => workerLoadBundle(db as never, data),
    namedQuery: (db, name) => workerNamedQuery(db as never, name),
    getDocFromCache: (ref) => readDocumentAs(ref as never, 'getDocFromCache'),
    getDocsFromCache: (q) => readQueryAs(q as never, 'getDocsFromCache'),
    documentSnapshotFromJSON: (db, json) => workerDocumentSnapshotFromJSON(db as never, json),
    querySnapshotFromJSON: (db, json) => workerQuerySnapshotFromJSON(db as never, json),
    onSnapshotResume: (db, json, ...args) => workerOnSnapshotResume(db as never, json, ...args),
  };
  return driver;
}
