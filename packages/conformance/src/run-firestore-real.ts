#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, deleteApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  setDoc,
  terminate,
  updateDoc,
} from 'firebase/firestore';
import { cert, deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { chromium } from '@playwright/test';
import { acquireRunLock } from './storage-stdlib-real-lock.ts';
import {
  FIREBASE_API,
  accessHeaders,
  jsonRequest,
  resolveServiceAccount,
  type AccessHeaders,
  type ServiceAccount,
  type WebConfig,
} from './storage-stdlib-real-api.ts';
import {
  activateFirestoreRules,
  hostedTestApiDiagnostics,
  injectFirestoreProbeRules,
  replaceSelectedRulesFile,
  restoreFirestoreRules,
  selectFirestoreRulesFile,
  snapshotFirestoreRules,
} from './firestore-real-rules.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATION_PATH = join(
  HERE,
  '..',
  'observations',
  'firestore',
  'firestore-transaction-contention-retries.json',
);
const BROWSER_OBSERVATION_PATH = join(
  HERE,
  '..',
  'observations',
  'firestore',
  'firestore-browser-lifecycle.json',
);
const RULES_GET_AFTER_OBSERVATION_PATH = join(
  HERE,
  '..',
  'observations',
  'firestore-rules',
  'rules-firestore-get-after-and-exists-after.json',
);
const LOCK_PATH = '/tmp/pyric-firestore-real.lock';

async function discoverWebConfig(
  sa: ServiceAccount,
  headers: AccessHeaders,
): Promise<WebConfig> {
  const listed = await jsonRequest<{ apps?: Array<{ appId: string }> }>(
    `${FIREBASE_API}/projects/${sa.project_id}/webApps`,
    { headers: headers.auth },
    'list Firebase Web Apps',
  );
  const appId = listed.apps?.[0]?.appId;
  if (!appId) {
    throw new Error('oracle project has no Web App; refusing to create persistent project resources');
  }
  return jsonRequest<WebConfig>(
    `${FIREBASE_API}/projects/${sa.project_id}/webApps/${encodeURIComponent(appId)}/config`,
    { headers: headers.auth },
    'read Firebase Web App config',
  );
}

async function waitForRulesPropagation(ms = 10_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function setWhenProbeRulesAreActive(
  ref: Parameters<typeof setDoc>[0],
  data: Record<string, unknown>,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  let consecutiveSuccesses = 0;
  while (Date.now() < deadline) {
    try {
      await setDoc(ref, data);
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses >= 5) return;
      await waitForRulesPropagation(1_000);
    } catch (error) {
      lastError = error;
      if ((error as { code?: unknown }).code !== 'permission-denied') throw error;
      consecutiveSuccesses = 0;
      await waitForRulesPropagation(1_000);
    }
  }
  throw new Error('timed out waiting for Firestore probe rules to reach the data plane', {
    cause: lastError,
  });
}

async function waitForTransactionRulesAreActive(
  db: ReturnType<typeof getFirestore>,
  ref: Parameters<typeof setDoc>[0],
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let consecutiveSuccesses = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await runTransaction(db, async (transaction) => {
        await transaction.get(ref);
      });
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses >= 3) return;
    } catch (error) {
      lastError = error;
      if ((error as { code?: unknown }).code !== 'permission-denied') throw error;
      consecutiveSuccesses = 0;
    }
    await waitForRulesPropagation(1_000);
  }
  throw new Error('timed out waiting for Firestore transaction rules propagation', {
    cause: lastError,
  });
}

async function captureTransactionContention(
  web: WebConfig,
  sa: ServiceAccount,
  runId: string,
): Promise<Record<string, unknown>> {
  const admin = initializeAdminApp(
    { credential: cert(sa as Parameters<typeof cert>[0]) },
    `pyric-firestore-real-admin-${runId}`,
  );
  const token = await getAdminAuth(admin).createCustomToken(`pyric-cdd-${runId}`);
  const firstApp = initializeApp(web as FirebaseOptions, `pyric-firestore-real-a-${runId}`);
  const secondApp = initializeApp(web as FirebaseOptions, `pyric-firestore-real-b-${runId}`);
  const firstAuth = getAuth(firstApp);
  const secondAuth = getAuth(secondApp);
  const firstDb = getFirestore(firstApp);
  const secondDb = getFirestore(secondApp);
  const base = `__pyric_firestore_cdd/${runId}`;
  const retryRefA = doc(firstDb, `${base}/cases/retry`);
  const retryRefB = doc(secondDb, `${base}/cases/retry`);
  const exhaustedRefA = doc(firstDb, `${base}/cases/exhausted`);
  const exhaustedRefB = doc(secondDb, `${base}/cases/exhausted`);

  try {
    await Promise.all([
      signInWithCustomToken(firstAuth, token),
      signInWithCustomToken(secondAuth, token),
    ]);

    console.log('[firestore:real] transaction clients authenticated');
    await setWhenProbeRulesAreActive(retryRefA, { count: 0 });
    await setWhenProbeRulesAreActive(retryRefB, { count: 0 });
    await waitForTransactionRulesAreActive(firstDb, retryRefA);
    await waitForTransactionRulesAreActive(secondDb, retryRefB);
    await setDoc(retryRefA, { count: 0 });
    console.log('[firestore:real] probe rules stable on data plane');
    const observedCounts: number[] = [];
    let retryAttempts = 0;
    await runTransaction(firstDb, async (tx) => {
      retryAttempts += 1;
      const snapshot = await tx.get(retryRefA);
      const count = snapshot.data()?.count as number;
      observedCounts.push(count);
      if (retryAttempts === 1) await updateDoc(retryRefB, { count: 40 });
      tx.update(retryRefA, { count: count + 2 });
    });
    const retryFinalCount = (await getDoc(retryRefA)).data()?.count;
    console.log('[firestore:real] retry contention captured');

    await setDoc(exhaustedRefA, { count: 0 });
    console.log('[firestore:real] exhaustion seed written');
    let exhaustedAttempts = 0;
    let exhaustedError: unknown;
    try {
      await runTransaction(firstDb, async (tx) => {
        exhaustedAttempts += 1;
        const snapshot = await tx.get(exhaustedRefA);
        await updateDoc(exhaustedRefB, { count: exhaustedAttempts });
        tx.update(exhaustedRefA, {
          count: ((snapshot.data()?.count as number) ?? 0) + 1,
        });
      }, { maxAttempts: 2 });
    } catch (error) {
      exhaustedError = error;
    }
    const shaped = exhaustedError as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      constructor?: { name?: unknown };
    } | undefined;
    const exhaustedFinalCount = (await getDoc(exhaustedRefA)).data()?.count;
    console.log('[firestore:real] exhaustion contention captured');

    return {
      retryAttempts,
      retryObservedCounts: observedCounts,
      retryFinalCount,
      exhaustedMaxAttempts: 2,
      exhaustedAttempts,
      exhaustedThrew: exhaustedError !== undefined,
      exhaustedCode: shaped?.code ?? null,
      exhaustedMessage: shaped?.message ?? null,
      exhaustedErrorName: shaped?.name ?? null,
      exhaustedConstructorName: shaped?.constructor?.name ?? null,
      exhaustedFinalCount,
    };
  } finally {
    await Promise.allSettled([deleteDoc(retryRefA), deleteDoc(exhaustedRefA)]);
    await Promise.allSettled([terminate(firstDb), terminate(secondDb)]);
    await Promise.allSettled([deleteApp(firstApp), deleteApp(secondApp)]);
    await deleteAdminApp(admin);
  }
}

async function captureBrowserLifecycle(
  web: WebConfig,
  sa: ServiceAccount,
  runId: string,
): Promise<Record<string, unknown>> {
  const admin = initializeAdminApp(
    { credential: cert(sa as Parameters<typeof cert>[0]) },
    `pyric-firestore-browser-admin-${runId}`,
  );
  const adminDb = getAdminFirestore(admin);
  const rulesBase = `__pyric_firestore_cdd/${runId}/rules_get_after`;
  await Promise.all([
    adminDb.doc(`${rulesBase}/exists_delete`).set({ x: 'seeded' }),
    adminDb.doc(`${rulesBase}/companion`).set({ count: 0 }),
  ]);
  const token = await getAdminAuth(admin).createCustomToken(`pyric-browser-${runId}`);
const browserSource = String.raw`
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
  enableNetwork,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  getDocsFromCache,
  getDocsFromServer,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  onSnapshotsInSync,
  setDoc,
  terminate,
  waitForPendingWrites,
  writeBatch,
} from 'firebase/firestore';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attempt = async (operation) => {
  try {
    const value = await operation();
    return { threw: false, code: null, message: null, value };
  } catch (error) {
    return {
      threw: true,
      code: error?.code ?? null,
      message: error?.message ?? String(error),
      value: null,
    };
  }
};
const writeWhenAllowed = async (ref, data) => {
  const deadline = Date.now() + 60000;
  let successes = 0;
  while (successes < 3 && Date.now() < deadline) {
    const result = await attempt(() => setDoc(ref, data));
    if (!result.threw) successes += 1;
    else if (result.code === 'permission-denied') successes = 0;
    else throw new Error(result.message);
    await delay(1000);
  }
  if (successes < 3) throw new Error('timed out waiting for client-specific rules propagation');
};

globalThis.runFirestoreLifecycleProbe = async (config, token, runId) => {
  const prefix = '__pyric_firestore_cdd/' + runId + '/browser/cases';
  const apps = [];
  const dbs = [];
  const make = async (label, initialize) => {
    const app = initializeApp(config, 'cdd-' + label + '-' + runId);
    apps.push(app);
    const auth = getAuth(app);
    await signInWithCustomToken(auth, token);
    const db = initialize ? initialize(app) : getFirestore(app);
    dbs.push(db);
    return { app, auth, db };
  };

  try {
    console.log('[lifecycle] rules readiness');
    const readiness = await make('readiness');
    const readinessRef = doc(readiness.db, prefix + '/readiness/value');
    await writeWhenAllowed(readinessRef, { ready: true });

    console.log('[lifecycle] getAfter and existsAfter');
    const after = await make('rules-after');
    const rulesAfterBase = '__pyric_firestore_cdd/' + runId + '/rules_get_after';
    const verdict = async (operation) => {
      const result = await attempt(operation);
      if (!result.threw) return 'ALLOW';
      if (result.code === 'permission-denied') return 'DENY';
      throw new Error('unexpected rules probe result: ' + result.message);
    };
    const getAfterTarget = await verdict(() =>
      setDoc(doc(after.db, rulesAfterBase + '/target_allow'), { x: 'value' })
    );
    const existsAfterCreate = await verdict(() =>
      setDoc(doc(after.db, rulesAfterBase + '/exists_create'), {})
    );
    const existsAfterDelete = await verdict(() =>
      deleteDoc(doc(after.db, rulesAfterBase + '/exists_delete'))
    );
    const existsAfterUnrelated = await verdict(() =>
      setDoc(doc(after.db, rulesAfterBase + '/exists_unrelated'), {})
    );
    const wrongExistsAfterCreate = await verdict(() =>
      setDoc(doc(after.db, rulesAfterBase + '/wrong_exists_create'), {})
    );
    const batch = writeBatch(after.db);
    batch.set(doc(after.db, rulesAfterBase + '/primary'), { written: true });
    batch.update(doc(after.db, rulesAfterBase + '/companion'), { count: 1 });
    const crossDocumentBatch = await verdict(() => batch.commit());
    const soloPrimary = await verdict(() =>
      setDoc(doc(after.db, rulesAfterBase + '/primary'), { solo: true })
    );

    console.log('[lifecycle] persistence precondition');
    const precondition = await make('precondition');
    await getDoc(doc(precondition.db, prefix + '/precondition/missing'));
    const persistenceAfterUse = await attempt(
      () => enableIndexedDbPersistence(precondition.db),
    );

    const multi = await make('multi');
    console.log('[lifecycle] multi-tab persistence');
    const multiTabEnable = await attempt(
      () => enableMultiTabIndexedDbPersistence(multi.db),
    );
    const multiAfterUse = await make('multi-after-use');
    await getDoc(doc(multiAfterUse.db, prefix + '/multi-after-use/missing'));
    const multiTabAfterUse = await attempt(
      () => enableMultiTabIndexedDbPersistence(multiAfterUse.db),
    );
    const multiFirst = await make('multi-first');
    const multiSecond = await make('multi-second');
    const multiTabTwoClients = await attempt(async () => {
      await enableMultiTabIndexedDbPersistence(multiFirst.db);
      await enableMultiTabIndexedDbPersistence(multiSecond.db);
    });

    const network = await make('network');
    console.log('[lifecycle] offline pending writes');
    const networkRef = doc(network.db, prefix + '/network/value');
    await writeWhenAllowed(networkRef, { value: 'online' });
    await disableNetwork(network.db);
    let writeSettled = false;
    let pendingSettled = false;
    const write = setDoc(networkRef, { value: 'offline' }).then(() => {
      writeSettled = true;
    });
    const pending = waitForPendingWrites(network.db).then(() => {
      pendingSettled = true;
    });
    await delay(250);
    const localWhileOffline = await getDoc(networkRef);
    const offlineState = {
      writePending: !writeSettled,
      waitForPendingWritesPending: !pendingSettled,
      localValue: localWhileOffline.data()?.value ?? null,
      fromCache: localWhileOffline.metadata.fromCache,
      hasPendingWrites: localWhileOffline.metadata.hasPendingWrites,
    };
    await enableNetwork(network.db);
    await Promise.all([write, pending]);
    const onlineAgain = await getDocFromServer(networkRef);
    const querySeedRef = doc(network.db, prefix + '/cache/query-seed');
    await writeWhenAllowed(querySeedRef, { value: 'server-only' });

    const cache = await make('cache', (app) =>
      initializeFirestore(app, { localCache: memoryLocalCache() })
    );
    console.log('[lifecycle] cache reads');
    const cacheRef = doc(cache.db, prefix + '/cache/value');
    const cacheQuery = collection(cache.db, prefix + '/cache');
    const coldCache = await attempt(() => getDocFromCache(cacheRef));
    const coldQueryCache = await getDocsFromCache(cacheQuery);
    const serverQuery = await getDocsFromServer(cacheQuery);
    const warmQueryCache = await getDocsFromCache(cacheQuery);
    await writeWhenAllowed(cacheRef, { value: 'warm' });
    await getDocFromServer(cacheRef);
    const warmCache = await getDocFromCache(cacheRef);

    const sync = await make('sync');
    console.log('[lifecycle] snapshots in sync');
    const syncRef = doc(sync.db, prefix + '/sync/value');
    const ordering = [];
    const stopSnapshot = onSnapshot(syncRef, (snapshot) => {
      ordering.push('snapshot:' + (snapshot.data()?.value ?? 'missing'));
    });
    const stopSync = onSnapshotsInSync(sync.db, () => ordering.push('sync'));
    await writeWhenAllowed(syncRef, { value: 'written' });
    const deadline = Date.now() + 10000;
    while (!ordering.some((entry) => entry === 'snapshot:written') && Date.now() < deadline) {
      await delay(25);
    }
    await delay(100);
    stopSnapshot();
    stopSync();

    const terminated = await make('terminated');
    console.log('[lifecycle] termination isolation');
    const terminatedRef = doc(terminated.db, prefix + '/terminated/value');
    await writeWhenAllowed(terminatedRef, { value: 'before' });
    await terminate(terminated.db);
    const readAfterTerminate = await attempt(() => getDoc(terminatedRef));
    const authAfterTerminate = await attempt(() => terminated.auth.currentUser.getIdToken());
    const sibling = await make('sibling');
    const siblingRef = doc(sibling.db, prefix + '/terminated/value');
    const siblingAfterTerminate = await attempt(
      async () => {
        await writeWhenAllowed(siblingRef, { value: 'sibling' });
        return (await getDoc(siblingRef)).data()?.value ?? null;
      },
    );

    await Promise.allSettled([
      deleteDoc(readinessRef),
      deleteDoc(networkRef),
      deleteDoc(querySeedRef),
      deleteDoc(cacheRef),
      deleteDoc(syncRef),
      deleteDoc(siblingRef),
    ]);

    return {
      persistenceAfterUseThrew: persistenceAfterUse.threw,
      persistenceAfterUseCode: persistenceAfterUse.code,
      multiTabEnableThrew: multiTabEnable.threw,
      multiTabEnableCode: multiTabEnable.code,
      multiTabAfterUseThrew: multiTabAfterUse.threw,
      multiTabAfterUseCode: multiTabAfterUse.code,
      multiTabTwoClientsThrew: multiTabTwoClients.threw,
      multiTabTwoClientsCode: multiTabTwoClients.code,
      offlineWritePending: offlineState.writePending,
      offlineWaitForPendingWritesPending: offlineState.waitForPendingWritesPending,
      offlineLocalValue: offlineState.localValue,
      offlineSnapshotFromCache: offlineState.fromCache,
      offlineSnapshotHasPendingWrites: offlineState.hasPendingWrites,
      reconnectedServerValue: onlineAgain.data()?.value ?? null,
      coldCacheThrew: coldCache.threw,
      coldCacheCode: coldCache.code,
      warmCacheValue: warmCache.data()?.value ?? null,
      coldQueryCacheSize: coldQueryCache.size,
      serverQuerySize: serverQuery.size,
      warmQueryCacheSize: warmQueryCache.size,
      snapshotSyncOrdering: ordering,
      rulesGetAfterBehavior: {
        'getAfter target == request.resource.data ALLOW': getAfterTarget,
        'existsAfter create true ALLOW': existsAfterCreate,
        'existsAfter delete false ALLOW': existsAfterDelete,
        'existsAfter unrelated mocked path ALLOW': existsAfterUnrelated,
        'wrong existsAfter on create DENY': wrongExistsAfterCreate,
      },
      rulesGetAfterCrossDocumentBatch: crossDocumentBatch,
      rulesGetAfterSoloPrimary: soloPrimary,
      readAfterTerminateThrew: readAfterTerminate.threw,
      readAfterTerminateCode: readAfterTerminate.code,
      authAfterTerminateThrew: authAfterTerminate.threw,
      siblingAfterTerminateThrew: siblingAfterTerminate.threw,
      siblingAfterTerminateValue: siblingAfterTerminate.value,
    };
  } finally {
    await Promise.allSettled(dbs.map((db) => terminate(db)));
    await Promise.allSettled(apps.map((app) => deleteApp(app)));
  }
};
`;
  const bundle = await Bun.build({
    entrypoints: ['virtual:firestore-lifecycle-probe'],
    target: 'browser',
    format: 'iife',
    plugins: [{
      name: 'firestore-lifecycle-probe',
      setup(builder) {
        builder.onResolve({ filter: /^virtual:firestore-lifecycle-probe$/ }, () => ({
          path: 'firestore-lifecycle-probe.js',
          namespace: 'firestore-lifecycle',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'firestore-lifecycle' }, () => ({
          contents: browserSource,
          loader: 'js',
        }));
      },
    }],
  });
  if (!bundle.success) {
    throw new Error(`browser lifecycle bundle failed: ${bundle.logs.map((log) => log.message).join('; ')}`);
  }
  const script = await bundle.outputs[0]!.text();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/probe.js') {
        return new Response(script, { headers: { 'content-type': 'text/javascript' } });
      }
      return new Response('<!doctype html><script src="/probe.js"></script>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (message) => console.log(`[firestore:browser] ${message.text()}`));
    page.on('pageerror', (error) => console.error(`[firestore:browser:error] ${error.message}`));
    page.on('crash', () => console.error('[firestore:browser] page crashed'));
    page.on('close', () => console.error('[firestore:browser] page closed'));
    browser.on('disconnected', () => console.error('[firestore:browser] browser disconnected'));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForFunction(() =>
      typeof (globalThis as { runFirestoreLifecycleProbe?: unknown }).runFirestoreLifecycleProbe === 'function'
    );
    return await page.evaluate(
      async ({ firebaseConfig, customToken, id }) => {
        return (globalThis as unknown as {
          runFirestoreLifecycleProbe(
            config: unknown,
            token: string,
            runId: string,
          ): Promise<Record<string, unknown>>;
        }).runFirestoreLifecycleProbe(firebaseConfig, customToken, id);
      },
      { firebaseConfig: web, customToken: token, id: runId },
    );
  } finally {
    await browser.close();
    server.stop(true);
    await Promise.allSettled([
      'target_allow', 'exists_create', 'exists_delete', 'exists_unrelated',
      'wrong_exists_create', 'primary', 'companion',
    ].map((id) => adminDb.doc(`${rulesBase}/${id}`).delete()));
    await deleteAdminApp(admin);
  }
}

async function run(): Promise<void> {
  const credentialPath = process.env.PYRIC_ORACLE_SA_PATH;
  if (!credentialPath) {
    console.log('[firestore:real] inert — set PYRIC_ORACLE_SA_PATH to capture.');
    return;
  }
  const releaseLock = acquireRunLock(LOCK_PATH);
  const browserOnly = Bun.argv.includes('--browser-only');
  let restoreVerified = false;
  try {
    const sa = resolveServiceAccount(credentialPath);
    const headers = await accessHeaders(sa);
    const web = await discoverWebConfig(sa, headers);
    if (web.projectId !== sa.project_id) throw new Error('Web config and service account target different projects');
    const runId = `r${Date.now().toString(36)}`;
    const snapshot = await snapshotFirestoreRules(sa, headers);
    const selected = selectFirestoreRulesFile(snapshot.ruleset);
    const content = injectFirestoreProbeRules(selected.content, runId);
    const files = replaceSelectedRulesFile(snapshot.ruleset, selected, content);
    let activationAttempted = false;
    let behavior: Record<string, unknown> | undefined;
    let browserBehavior: Record<string, unknown> | undefined;
    let probeRulesetName: string | undefined;
    try {
      activationAttempted = true;
      probeRulesetName = await activateFirestoreRules(sa, headers, snapshot, files);
      await waitForRulesPropagation();
      behavior = browserOnly
        ? (JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as { behavior: Record<string, unknown> }).behavior
        : await captureTransactionContention(web, sa, runId);
      browserBehavior = await captureBrowserLifecycle(web, sa, runId);
    } finally {
      if (activationAttempted) {
        await restoreFirestoreRules(headers, snapshot);
        restoreVerified = true;
      }
    }
    if (!behavior || !browserBehavior || !probeRulesetName || !restoreVerified) {
      throw new Error('probe did not complete with verified rules restoration');
    }
    const firebasePackage = JSON.parse(
      readFileSync(fileURLToPath(await import.meta.resolve('firebase/package.json')), 'utf8'),
    ) as { version: string };
    const observation = {
      name: 'firestore-transaction-contention-retries',
      matrixRow: 'firestore #93',
      rowIds: ['firestore#93'],
      description: 'Two authenticated Web SDK clients contend on transaction read documents; captures callback retries, fresh reads, maxAttempts exhaustion, and the terminal error shape.',
      observedAt: new Date().toISOString(),
      fbSdkVersion: firebasePackage.version,
      projectId: sa.project_id,
      inputDigest: createHash('sha256').update(content).digest('hex'),
      lifecycle: {
        originalRulesetName: snapshot.release.rulesetName,
        probeRulesetName,
        restoredOriginalRelease: restoreVerified,
      },
      behavior,
    };
    mkdirSync(dirname(OBSERVATION_PATH), { recursive: true });
    if (!browserOnly) {
      writeFileSync(OBSERVATION_PATH, `${JSON.stringify(observation, null, 2)}\n`);
      console.log(`[firestore:real] captured ${OBSERVATION_PATH}`);
    }
    const browserObservation = {
      name: 'firestore-browser-lifecycle',
      matrixRow: 'firestore #140, #141, #143, #144, #145, #146, #148, #150, #152',
      rowIds: [
        'firestore#140', 'firestore#141', 'firestore#143', 'firestore#144',
        'firestore#145', 'firestore#146', 'firestore#148', 'firestore#150',
        'firestore#152',
      ],
      description: 'Real-Chromium production capture for persistence preconditions, offline pending writes, explicit cache behavior, snapshot synchronization, and Firestore-only termination.',
      observedAt: new Date().toISOString(),
      fbSdkVersion: firebasePackage.version,
      projectId: sa.project_id,
      inputDigest: createHash('sha256').update(content).digest('hex'),
      lifecycle: {
        originalRulesetName: snapshot.release.rulesetName,
        probeRulesetName,
        restoredOriginalRelease: restoreVerified,
      },
      behavior: browserBehavior,
    };
    writeFileSync(
      BROWSER_OBSERVATION_PATH,
      `${JSON.stringify(browserObservation, null, 2)}\n`,
    );
    console.log(`[firestore:real] captured ${BROWSER_OBSERVATION_PATH}`);
    const previousRulesObservation = JSON.parse(
      readFileSync(RULES_GET_AFTER_OBSERVATION_PATH, 'utf8'),
    ) as Record<string, unknown> & { diagnostics?: unknown };
    const rulesObservation = {
      ...previousRulesObservation,
      description: 'Authenticated Web SDK operations against temporarily deployed production rules verify getAfter()/existsAfter() target, existence, and cross-document atomic projection semantics. The hosted Rules Test API limitation is retained separately in diagnostics.',
      observedAt: new Date().toISOString(),
      fbSdkVersion: firebasePackage.version,
      projectId: sa.project_id,
      lifecycle: {
        originalRulesetName: snapshot.release.rulesetName,
        probeRulesetName,
        restoredOriginalRelease: restoreVerified,
      },
      deployedRulesDigest: {
        algorithm: 'sha256',
        value: createHash('sha256').update(content).digest('hex'),
      },
      behavior: browserBehavior.rulesGetAfterBehavior,
      diagnostics: {
        productionDatabase: {
          crossDocumentBatch: browserBehavior.rulesGetAfterCrossDocumentBatch,
          soloPrimary: browserBehavior.rulesGetAfterSoloPrimary,
        },
        hostedTestApiLimitation: hostedTestApiDiagnostics(
          previousRulesObservation.diagnostics,
        ),
      },
    };
    writeFileSync(
      RULES_GET_AFTER_OBSERVATION_PATH,
      `${JSON.stringify(rulesObservation, null, 2)}\n`,
    );
    console.log(`[firestore:real] captured ${RULES_GET_AFTER_OBSERVATION_PATH}`);
  } finally {
    releaseLock();
  }
}

await run();
