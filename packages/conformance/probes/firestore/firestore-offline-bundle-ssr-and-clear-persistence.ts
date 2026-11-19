import { FirebaseError, deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  DocumentSnapshot,
  FirestoreError,
  LoadBundleTask,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  clearIndexedDbPersistence,
  disableNetwork,
  doc,
  documentSnapshotFromJSON,
  getDocFromCache,
  getDocsFromCache,
  getFirestore,
  initializeFirestore,
  loadBundle,
  memoryLocalCache,
  namedQuery,
  onSnapshotResume,
  querySnapshotFromJSON,
  setLogLevel,
  terminate,
  type Firestore,
  type LoadBundleTaskProgress,
  type Unsubscribe,
} from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';

interface ObservedCallOutcome {
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isFirestoreError: boolean;
  isFirebaseError: boolean;
}

interface ObservedProgressStep {
  taskState: string;
  documentsLoaded: number;
  totalDocuments: number;
  bytesLoaded: number;
  totalBytes: number;
}

function noErrorOutcome(): ObservedCallOutcome {
  return {
    threw: false,
    threwSynchronously: false,
    code: null,
    errorName: null,
    isFirestoreError: false,
    isFirebaseError: false,
  };
}

function errorOutcomeOf(err: unknown, threwSynchronously: boolean): ObservedCallOutcome {
  let code: string | null = null;
  let errorName: string | null = null;
  if (err !== null && typeof err === 'object') {
    const record = err as { code?: unknown; name?: unknown };
    if (typeof record.code === 'string') {
      code = record.code;
    }
    if (typeof record.name === 'string') {
      errorName = record.name;
    }
  }
  return {
    threw: true,
    threwSynchronously,
    code,
    errorName,
    isFirestoreError: err instanceof FirestoreError,
    isFirebaseError: err instanceof FirebaseError,
  };
}

function observeSyncThrow(fn: () => unknown): ObservedCallOutcome {
  try {
    fn();
    return noErrorOutcome();
  } catch (err) {
    return errorOutcomeOf(err, true);
  }
}

async function observeAsyncVoidCall(
  fn: () => Promise<void>,
): Promise<ObservedCallOutcome & { isPromise: boolean; resolvedUndefined: boolean }> {
  let promiseValue: Promise<void>;
  try {
    promiseValue = fn();
  } catch (err) {
    return {
      ...errorOutcomeOf(err, true),
      isPromise: false,
      resolvedUndefined: false,
    };
  }
  const isPromise = promiseValue instanceof Promise;
  try {
    const settled = await promiseValue;
    return {
      ...noErrorOutcome(),
      isPromise,
      resolvedUndefined: settled === undefined,
    };
  } catch (err) {
    return {
      ...errorOutcomeOf(err, false),
      isPromise,
      resolvedUndefined: false,
    };
  }
}

function encodeLengthPrefixedElements(elements: readonly unknown[]): string {
  const encoder = new TextEncoder();
  let encoded = '';
  for (const element of elements) {
    const json = JSON.stringify(element);
    const byteLength = encoder.encode(json).byteLength;
    encoded += `${byteLength}${json}`;
  }
  return encoded;
}

function buildSyntheticArticlesBundle(projectId: string): string {
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
            where: {
              fieldFilter: {
                field: { fieldPath: 'published' },
                op: 'EQUAL',
                value: { booleanValue: true },
              },
            },
            orderBy: [
              { field: { fieldPath: 'rank' }, direction: 'ASCENDING' },
              { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
            ],
          },
          limitType: 'FIRST',
        },
      },
    },
    {
      documentMetadata: {
        name: alphaName,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: true,
        queries: ['published-articles'],
      },
    },
    {
      document: {
        name: alphaName,
        createTime: '2026-01-15T11:00:00.000000000Z',
        updateTime: '2026-01-15T11:30:00.000000000Z',
        fields: {
          title: { stringValue: 'First Post' },
          published: { booleanValue: true },
          rank: { integerValue: '1' },
        },
      },
    },
    {
      documentMetadata: {
        name: betaName,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: true,
        queries: [],
      },
    },
    {
      document: {
        name: betaName,
        createTime: '2026-01-15T11:05:00.000000000Z',
        updateTime: '2026-01-15T11:35:00.000000000Z',
        fields: {
          title: { stringValue: 'Draft Note' },
          published: { booleanValue: false },
          rank: { integerValue: '2' },
        },
      },
    },
    {
      documentMetadata: {
        name: ghostName,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: false,
        queries: [],
      },
    },
  ];

  const bodyPayload = encodeLengthPrefixedElements(bodyElements);
  const totalBytes = new TextEncoder().encode(bodyPayload).byteLength;
  const headerPayload = encodeLengthPrefixedElements([
    {
      metadata: {
        id: 'articles-bundle-v1',
        createTime: '2026-01-15T12:00:00.000000000Z',
        version: 1,
        totalDocuments: 3,
        totalBytes,
      },
    },
  ]);
  return headerPayload + bodyPayload;
}

function toProgressStep(progress: LoadBundleTaskProgress): ObservedProgressStep {
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
  if (typeof candidate.type === 'string') {
    return candidate.type;
  }
  return null;
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'firestore#153',
  rowIds: ['firestore#142', 'firestore#153', 'firestore#154'],
  description:
    'Pure offline firebase/firestore loadBundle, LoadBundleTask, and namedQuery cache hydration; DocumentSnapshot.toJSON and QuerySnapshot.toJSON serialization into documentSnapshotFromJSON, querySnapshotFromJSON, and onSnapshotResume on fresh clients; and clearIndexedDbPersistence lifecycle preconditions with zero network calls.',
  async observe() {
    const projectId = 'demo-firestore-bundle-ssr-probe';
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline firestore bundle/SSR probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    const apps: FirebaseApp[] = [];
    const activeHandles = new Set<Firestore>();
    const activeUnsubs: Unsubscribe[] = [];

    const openApp = (label: string): FirebaseApp => {
      const app = initializeApp(
        { apiKey: 'fake-api-key', projectId },
        `firestore-bundle-ssr-probe-${label}`,
      );
      apps.push(app);
      return app;
    };

    const openOfflineMemoryDb = async (label: string): Promise<Firestore> => {
      const app = openApp(label);
      const db = initializeFirestore(app, { localCache: memoryLocalCache() });
      activeHandles.add(db);
      await disableNetwork(db);
      return db;
    };

    try {
      const bundleString = buildSyntheticArticlesBundle(projectId);
      const bundleBytes = new TextEncoder().encode(bundleString);
      const bundleArrayBuffer = bundleBytes.buffer.slice(
        bundleBytes.byteOffset,
        bundleBytes.byteOffset + bundleBytes.byteLength,
      );

      const dbProducer = await openOfflineMemoryDb('producer');
      const progressEvents: ObservedProgressStep[] = [];
      let onProgressCompleted = false;
      const stringTask = loadBundle(dbProducer, bundleString);
      const isLoadBundleTaskInstance = stringTask instanceof LoadBundleTask;
      stringTask.onProgress(
        (progress) => {
          progressEvents.push(toProgressStep(progress));
        },
        undefined,
        () => {
          onProgressCompleted = true;
        },
      );
      const finalStringProgress = toProgressStep(await stringTask);

      const dbBytes = await openOfflineMemoryDb('uint8');
      const finalBytesProgress = toProgressStep(
        await loadBundle(dbBytes, bundleBytes as unknown as Parameters<typeof loadBundle>[1]),
      );
      const bytesAlphaSnap = await getDocFromCache(doc(dbBytes, 'articles/alpha'));

      const arrayBufferOutcome = observeSyncThrow(() =>
        loadBundle(dbBytes, bundleArrayBuffer),
      );

      let malformedProgressErrorInvoked = false;
      let malformedBundleOutcome: ObservedCallOutcome;
      setLogLevel('silent');
      try {
        const badTask = loadBundle(dbProducer, 'not-a-valid-bundle');
        badTask.onProgress(undefined, () => {
          malformedProgressErrorInvoked = true;
        });
        try {
          await badTask;
          malformedBundleOutcome = noErrorOutcome();
        } catch (err) {
          malformedBundleOutcome = errorOutcomeOf(err, false);
        }
      } finally {
        setLogLevel('error');
      }

      const publishedQuery = await namedQuery(dbProducer, 'published-articles');
      const missingNamedQuery = await namedQuery(dbProducer, 'missing-bundle-query');
      if (publishedQuery === null) {
        throw new Error('Expected published-articles namedQuery to resolve to a Query');
      }

      const alphaSnap = await getDocFromCache(doc(dbProducer, 'articles/alpha'));
      const betaSnap = await getDocFromCache(doc(dbProducer, 'articles/beta'));
      const ghostSnap = await getDocFromCache(doc(dbProducer, 'articles/ghost'));
      const publishedQuerySnap = await getDocsFromCache(publishedQuery);

      const alphaJson = alphaSnap.toJSON();
      const ghostJson = ghostSnap.toJSON();
      const queryJson = publishedQuerySnap.toJSON();

      const dbConsumer = await openOfflineMemoryDb('ssr-consumer');
      const hydratedAlpha = documentSnapshotFromJSON(dbConsumer, alphaJson);
      const hydratedMissingDocOutcome = observeSyncThrow(() =>
        documentSnapshotFromJSON(dbConsumer, ghostJson),
      );
      const hydratedQuery = querySnapshotFromJSON(dbConsumer, queryJson);

      let missingDocBundleIsEmpty = false;
      const ghostCandidate = ghostJson as { bundle?: unknown };
      if (ghostCandidate.bundle === '') {
        missingDocBundleIsEmpty = true;
      }

      const invalidSsrJsonChecks = {
        docFromEmptyObject: observeSyncThrow(() => documentSnapshotFromJSON(dbConsumer, {})),
        docFromQueryJson: observeSyncThrow(() =>
          documentSnapshotFromJSON(dbConsumer, queryJson),
        ),
        queryFromEmptyObject: observeSyncThrow(() => querySnapshotFromJSON(dbConsumer, {})),
        queryFromDocJson: observeSyncThrow(() =>
          querySnapshotFromJSON(dbConsumer, alphaJson),
        ),
      };

      const dbResumeDoc = await openOfflineMemoryDb('resume-doc');
      let unsubDocReturnType = '';
      const resumedDocSnapshot = await new Promise<{
        isDocumentSnapshotInstance: boolean;
        exists: boolean;
        id: string;
        path: string;
        fromCache: boolean;
        hasPendingWrites: boolean;
        data: unknown;
      }>((resolve, reject) => {
        const unsub = onSnapshotResume(
          dbResumeDoc,
          alphaJson,
          (snap: DocumentSnapshot) => {
            resolve({
              isDocumentSnapshotInstance: snap instanceof DocumentSnapshot,
              exists: snap.exists(),
              id: snap.id,
              path: snap.ref.path,
              fromCache: snap.metadata.fromCache,
              hasPendingWrites: snap.metadata.hasPendingWrites,
              data: snap.data() ?? null,
            });
          },
          (err) => {
            reject(err);
          },
        );
        unsubDocReturnType = typeof unsub;
        activeUnsubs.push(unsub);
      });

      const dbResumeQuery = await openOfflineMemoryDb('resume-query');
      let unsubQueryReturnType = '';
      const resumedQuerySnapshot = await new Promise<{
        isQuerySnapshotInstance: boolean;
        size: number;
        empty: boolean;
        fromCache: boolean;
        hasPendingWrites: boolean;
        ids: string[];
        docsData: unknown[];
      }>((resolve, reject) => {
        const unsub = onSnapshotResume(dbResumeQuery, queryJson, {
          next: (snap: QuerySnapshot) => {
            resolve({
              isQuerySnapshotInstance: snap instanceof QuerySnapshot,
              size: snap.size,
              empty: snap.empty,
              fromCache: snap.metadata.fromCache,
              hasPendingWrites: snap.metadata.hasPendingWrites,
              ids: snap.docs.map((entry) => entry.id),
              docsData: snap.docs.map((entry) => entry.data()),
            });
          },
          error: (err) => {
            reject(err);
          },
        });
        unsubQueryReturnType = typeof unsub;
        activeUnsubs.push(unsub);
      });

      const appClearFresh = openApp('clear-fresh');
      const dbClearFresh = getFirestore(appClearFresh);
      activeHandles.add(dbClearFresh);
      const clearBeforeStart = await observeAsyncVoidCall(() =>
        clearIndexedDbPersistence(dbClearFresh),
      );

      const dbClearRunning = await openOfflineMemoryDb('clear-running');
      const clearWhileRunning = await observeAsyncVoidCall(() =>
        clearIndexedDbPersistence(dbClearRunning),
      );
      await terminate(dbClearRunning);
      activeHandles.delete(dbClearRunning);
      const clearAfterTerminate = await observeAsyncVoidCall(() =>
        clearIndexedDbPersistence(dbClearRunning),
      );

      return {
        fetchCalls,
        bundleLoading: {
          isLoadBundleTaskInstance,
          onProgressCompleted,
          progressEvents,
          finalStringProgress,
          finalBytesProgress,
          uint8AlphaExists: bytesAlphaSnap.exists(),
          uint8AlphaData: bytesAlphaSnap.data() ?? null,
          arrayBufferOnNodePlatform: arrayBufferOutcome,
          malformedBundle: {
            ...malformedBundleOutcome,
            progressErrorInvoked: malformedProgressErrorInvoked,
          },
          cachedDocuments: {
            alpha: {
              exists: alphaSnap.exists(),
              id: alphaSnap.id,
              fromCache: alphaSnap.metadata.fromCache,
              data: alphaSnap.data() ?? null,
            },
            beta: {
              exists: betaSnap.exists(),
              id: betaSnap.id,
              fromCache: betaSnap.metadata.fromCache,
              data: betaSnap.data() ?? null,
            },
            ghost: {
              exists: ghostSnap.exists(),
              id: ghostSnap.id,
              fromCache: ghostSnap.metadata.fromCache,
              dataIsUndefined: ghostSnap.data() === undefined,
            },
          },
          namedQueries: {
            foundIsQueryInstance: publishedQuery instanceof Query,
            missingQueryIsNull: missingNamedQuery === null,
            publishedQueryResult: {
              size: publishedQuerySnap.size,
              empty: publishedQuerySnap.empty,
              fromCache: publishedQuerySnap.metadata.fromCache,
              ids: publishedQuerySnap.docs.map((entry) => entry.id),
              docsData: publishedQuerySnap.docs.map((entry) => entry.data()),
            },
          },
        },
        ssrSnapshotHydration: {
          serializedEnvelope: {
            docJsonType: extractJsonTypeTag(alphaJson),
            docJsonKeys: Object.keys(alphaJson).sort(),
            queryJsonType: extractJsonTypeTag(queryJson),
            queryJsonKeys: Object.keys(queryJson).sort(),
          },
          hydratedExistingDoc: {
            isDocumentSnapshotInstance: hydratedAlpha instanceof DocumentSnapshot,
            exists: hydratedAlpha.exists(),
            id: hydratedAlpha.id,
            path: hydratedAlpha.ref.path,
            fromCache: hydratedAlpha.metadata.fromCache,
            hasPendingWrites: hydratedAlpha.metadata.hasPendingWrites,
            data: hydratedAlpha.data() ?? null,
            titleViaGet: hydratedAlpha.get('title'),
          },
          hydratedMissingDoc: {
            serializedType: extractJsonTypeTag(ghostJson),
            serializedBundleIsEmpty: missingDocBundleIsEmpty,
            fromJsonOutcome: hydratedMissingDocOutcome,
          },
          hydratedQuerySnapshot: {
            isQuerySnapshotInstance: hydratedQuery instanceof QuerySnapshot,
            size: hydratedQuery.size,
            empty: hydratedQuery.empty,
            fromCache: hydratedQuery.metadata.fromCache,
            hasPendingWrites: hydratedQuery.metadata.hasPendingWrites,
            docs: hydratedQuery.docs.map((entry) => ({
              id: entry.id,
              path: entry.ref.path,
              isQueryDocumentSnapshotInstance: entry instanceof QueryDocumentSnapshot,
              data: entry.data(),
            })),
          },
          resumedDocumentListener: {
            unsubscribeReturnType: unsubDocReturnType,
            snapshot: resumedDocSnapshot,
          },
          resumedQueryListener: {
            unsubscribeReturnType: unsubQueryReturnType,
            snapshot: resumedQuerySnapshot,
          },
          invalidSsrJsonChecks,
        },
        clearPersistenceLifecycle: {
          beforeStart: clearBeforeStart,
          whileRunning: clearWhileRunning,
          afterTerminate: clearAfterTerminate,
        },
      };
    } finally {
      globalThis.fetch = originalFetch;
      for (const unsub of activeUnsubs) {
        unsub();
      }
      for (const handle of activeHandles) {
        await terminate(handle);
      }
      for (const app of apps) {
        await deleteApp(app);
      }
    }
  },
};
