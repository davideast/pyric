#!/usr/bin/env bun
/** Capture multi-app topology against the production Web SDK in real Chromium. */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authStorageSignalMatches,
  observeCrossTabAuthAfterPersistenceSignal,
  type AuthStorageSignal,
} from './cross-tab-auth-observer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATION = join(HERE, '..', 'observations', 'app', 'app-production-multi-app-topology.json');
const CROSS_TAB_OBSERVATION = join(
  HERE,
  '..',
  'observations',
  'app',
  'app-production-cross-tab-auth-persistence.json',
);
const rawConfig = process.env.PYRIC_ORACLE_FIREBASE_CONFIG;
if (!rawConfig) {
  throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG is required; run oracle:plan before this production capture.');
}
const config = JSON.parse(rawConfig) as { apiKey: string; projectId: string };
const firebasePackage = JSON.parse(readFileSync(
  fileURLToPath(import.meta.resolve('firebase/package.json')),
  'utf8',
)) as { version: string };

const browserSource = String.raw`
import { initializeApp, deleteApp } from 'firebase/app';
import {
  browserLocalPersistence,
  deleteUser,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, getFirestore, onSnapshot, setDoc, deleteDoc } from 'firebase/firestore';
import { getDatabase, onValue, ref, set, remove } from 'firebase/database';

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!predicate()) throw new Error('timed out waiting for ' + label);
};

const captureAsync = async (operation) => {
  try {
    const value = await operation();
    return {
      threw: false,
      code: null,
      message: null,
      uid: value?.user?.uid ?? null,
    };
  } catch (error) {
    return {
      threw: true,
      code: error?.code ?? null,
      message: error?.message ?? String(error),
      uid: null,
    };
  }
};

let crossTabApp;
let crossTabAuth;
let crossTabEvents = [];
let stopCrossTabAuth;
let crossTabPersistenceSignals = [];

globalThis.addEventListener('storage', (event) => {
  if (event.storageArea === localStorage && event.key?.startsWith('firebase:authUser:')) {
    crossTabPersistenceSignals.push({ key: event.key, newValue: event.newValue });
  }
});

globalThis.setupCrossTabAuth = async (config) => {
  crossTabApp = initializeApp(config);
  crossTabAuth = getAuth(crossTabApp);
  await setPersistence(crossTabAuth, browserLocalPersistence);
  stopCrossTabAuth = onAuthStateChanged(
    crossTabAuth,
    (user) => crossTabEvents.push(user?.uid ?? null),
  );
  await waitFor(() => crossTabEvents.length === 1, 'cross-tab initial Auth state');
  return crossTabEvents;
};

globalThis.signInCrossTabAnonymously = async () => {
  const user = (await signInAnonymously(crossTabAuth)).user;
  await waitFor(() => crossTabAuth.currentUser?.uid === user.uid, 'cross-tab source sign-in');
  return user.uid;
};

globalThis.readCrossTabAuth = () => ({
  currentUid: crossTabAuth?.currentUser?.uid ?? null,
  events: [...crossTabEvents],
  persistenceSignals: [...crossTabPersistenceSignals],
});

globalThis.resetCrossTabPersistenceSignals = () => {
  crossTabPersistenceSignals = [];
};

globalThis.deleteCrossTabUser = async () => {
  if (crossTabAuth?.currentUser) await deleteUser(crossTabAuth.currentUser);
  await waitFor(() => crossTabAuth.currentUser === null, 'cross-tab source cleanup');
};

globalThis.cleanupCrossTabAuth = async () => {
  stopCrossTabAuth?.();
  if (crossTabApp) await deleteApp(crossTabApp);
};

globalThis.runAppProductionProbe = async (config) => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  console.log('[app-production-probe] auth topology');

  const authAApp = initializeApp(config, 'oracle-auth-a-' + suffix);
  const authBApp = initializeApp({ ...config }, 'oracle-auth-b-' + suffix);
  const authA = getAuth(authAApp);
  const authB = getAuth(authBApp);
  const authAFires = [];
  const authBFires = [];
  const stopAuthA = onAuthStateChanged(authA, (user) => authAFires.push(user?.uid ?? null));
  const stopAuthB = onAuthStateChanged(authB, (user) => authBFires.push(user?.uid ?? null));
  await waitFor(() => authAFires.length === 1 && authBFires.length === 1, 'initial auth observers');
  const authAUser = (await signInAnonymously(authA)).user;
  await waitFor(() => authA.currentUser !== null, 'app A sign-in');
  const bStayedSignedOut = authB.currentUser === null && authBFires.length === 1;
  const authBUser = (await signInAnonymously(authB)).user;
  await waitFor(() => authB.currentUser !== null, 'app B sign-in');
  const distinctSessions = authA.currentUser?.uid === authAUser.uid
    && authB.currentUser?.uid === authBUser.uid
    && authAUser.uid !== authBUser.uid;
  await signOut(authA);
  await waitFor(() => authA.currentUser === null, 'app A sign-out');
  const bStayedSignedIn = authB.currentUser?.uid === authBUser.uid;
  stopAuthA();
  stopAuthB();
  await deleteUser(authBUser);
  await deleteApp(authAApp);
  await deleteApp(authBApp);

  const retainedAuthApp = initializeApp(config, 'oracle-retained-auth-' + suffix);
  const retainedAuth = getAuth(retainedAuthApp);
  await deleteApp(retainedAuthApp);
  const retainedAuthAttempt = await captureAsync(
    () => signInAnonymously(retainedAuth),
  );
  const retainedAuthSignInAfterDelete = {
    threw: retainedAuthAttempt.threw,
    code: retainedAuthAttempt.code,
  };
  if (!retainedAuthAttempt.threw && retainedAuth.currentUser) {
    try { await deleteUser(retainedAuth.currentUser); } catch {}
  }

  console.log('[app-production-probe] data topology');
  const dataAApp = initializeApp(config, 'oracle-data-a-' + suffix);
  const dataBApp = initializeApp({ ...config }, 'oracle-data-b-' + suffix);
  const dataAAuth = getAuth(dataAApp);
  const dataBAuth = getAuth(dataBApp);
  await signInAnonymously(dataAAuth);
  const dataBUser = (await signInAnonymously(dataBAuth)).user;
  const firestoreA = getFirestore(dataAApp);
  const firestoreB = getFirestore(dataBApp);
  const firestorePath = 'pyric_oracle/' + suffix + '/multi-app/shared';
  const firestoreARef = doc(firestoreA, firestorePath);
  const firestoreBRef = doc(firestoreB, firestorePath);
  await setDoc(firestoreARef, { value: 'from-a' });
  const firestoreShared = (await getDoc(firestoreBRef)).data()?.value === 'from-a';
  const firestoreAValues = [];
  const firestoreBValues = [];
  const firestoreAErrors = [];
  const firestoreBErrors = [];
  onSnapshot(firestoreARef, (snap) => firestoreAValues.push(snap.data()?.value ?? null),
    (error) => firestoreAErrors.push(error.code ?? error.message));
  const stopFirestoreB = onSnapshot(firestoreBRef,
    (snap) => firestoreBValues.push(snap.data()?.value ?? null),
    (error) => firestoreBErrors.push(error.code ?? error.message));
  await waitFor(() => firestoreAValues.includes('from-a') && firestoreBValues.includes('from-a'), 'initial Firestore listeners');

  const databaseA = getDatabase(dataAApp);
  const databaseB = getDatabase(dataBApp);
  const databasePath = 'pyric_oracle/' + suffix + '/multi-app/shared';
  const databaseARef = ref(databaseA, databasePath);
  const databaseBRef = ref(databaseB, databasePath);
  const databaseAValues = [];
  const databaseBValues = [];
  onValue(databaseARef, (snap) => databaseAValues.push(snap.val()));
  const stopDatabaseB = onValue(databaseBRef, (snap) => databaseBValues.push(snap.val()));
  await set(databaseARef, 'from-a');
  await waitFor(() => databaseAValues.includes('from-a') && databaseBValues.includes('from-a'), 'initial RTDB listeners');
  const databaseShared = (await new Promise((resolve) => {
    onValue(databaseBRef, (snap) => resolve(snap.val()), { onlyOnce: true });
  })) === 'from-a';

  console.log('[app-production-probe] deletion topology');
  const firestoreABeforeDelete = firestoreAValues.length;
  const databaseABeforeDelete = databaseAValues.length;
  await deleteApp(dataAApp);
  await setDoc(firestoreBRef, { value: 'after-delete' });
  await set(databaseBRef, 'after-delete');
  await waitFor(() => firestoreBValues.includes('after-delete'), 'sibling Firestore listener');
  await waitFor(() => databaseBValues.includes('after-delete'), 'sibling RTDB listener');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const deletedAppFirestoreListenerOutcome = firestoreAValues.length > firestoreABeforeDelete
    ? 'delivered-after-delete'
    : firestoreAErrors.length > 0
      ? 'errored-after-delete'
      : 'stopped-silently';

  const behavior = {
    equalConfigAppsAreDistinct: authAApp !== authBApp && dataAApp !== dataBApp,
    authServicesAreDistinct: authA !== authB,
    signInOnOneLeavesSiblingSignedOut: bStayedSignedOut,
    sessionsUseDistinctUsers: distinctSessions,
    signOutOnOneLeavesSiblingSignedIn: bStayedSignedIn,
    retainedAuthSignInAfterDelete,
    firestoreServicesAreDistinct: firestoreA !== firestoreB,
    firestoreDataIsShared: firestoreShared,
    rtdbServicesAreDistinct: databaseA !== databaseB,
    rtdbDataIsShared: databaseShared,
    deletedAppFirestoreListenerStopped:
      firestoreAValues.length === firestoreABeforeDelete && firestoreAErrors.length === 0,
    deletedAppFirestoreListenerOutcome,
    deletedAppFirestoreListenerErrorCodes: [...firestoreAErrors],
    deletedAppRtdbListenerStopped:
      databaseAValues.length === databaseABeforeDelete,
    siblingFirestoreListenerSurvived: firestoreBValues.includes('after-delete') && firestoreBErrors.length === 0,
    siblingRtdbListenerSurvived: databaseBValues.includes('after-delete'),
  };

  console.log('[app-production-probe] cleanup');
  stopFirestoreB();
  stopDatabaseB();
  await deleteDoc(firestoreBRef);
  await remove(databaseBRef);
  await deleteUser(dataBUser);
  await deleteApp(dataBApp);
  return behavior;
};
`;

const bundle = await Bun.build({
  entrypoints: ['virtual:app-production-probe'],
  target: 'browser',
  format: 'iife',
  plugins: [{
    name: 'app-production-probe',
    setup(builder) {
      builder.onResolve({ filter: /^virtual:app-production-probe$/ }, () => ({
        path: 'app-production-probe.js',
        namespace: 'app-production',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'app-production' }, () => ({
        contents: browserSource,
        loader: 'js',
      }));
    },
  }],
});
if (!bundle.success) {
  throw new Error(`browser probe bundle failed: ${bundle.logs.map((log) => log.message).join('; ')}`);
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

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const siblingPage = await context.newPage();
  page.on('console', (message) => console.log(`[browser] ${message.text()}`));
  page.on('pageerror', (error) => console.error(`[browser error] ${error.message}`));
  page.on('crash', () => console.error('[browser] page crashed'));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.log(`[browser] navigated ${frame.url()}`);
  });
  await page.goto(`http://localhost:${server.port}`);
  await siblingPage.goto(`http://localhost:${server.port}`);
  await page.waitForFunction(() => typeof (globalThis as { runAppProductionProbe?: unknown }).runAppProductionProbe === 'function');
  await siblingPage.waitForFunction(() => typeof (globalThis as { setupCrossTabAuth?: unknown }).setupCrossTabAuth === 'function');
  const behavior = await page.evaluate(async (firebaseConfig) => {
    const run = (globalThis as unknown as {
      runAppProductionProbe(config: unknown): Promise<Record<string, unknown>>;
    }).runAppProductionProbe;
    return run(firebaseConfig);
  }, config);
  const observation = {
    name: 'app-production-multi-app-topology',
    matrixRow: 'app #23, app #25, app #26, auth #183',
    rowIds: ['app#23', 'app#25', 'app#26', 'auth#183'],
    description:
      'Real-browser production capture for equal-config app backend sharing, independent Auth sessions, retained-Auth deletion behavior, and deleted-app Firestore/RTDB listener isolation.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: firebasePackage.version,
    projectId: config.projectId,
    behavior,
  };
  mkdirSync(dirname(OBSERVATION), { recursive: true });
  writeFileSync(OBSERVATION, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`[app-production] wrote ${OBSERVATION}`);
  console.log(JSON.stringify(behavior));

  await Promise.all([page, siblingPage].map((targetPage) => targetPage.evaluate(
    async (firebaseConfig) => {
      const setup = (globalThis as unknown as {
        setupCrossTabAuth(config: unknown): Promise<unknown>;
      }).setupCrossTabAuth;
      await setup(firebaseConfig);
    },
    config,
  )));
  await Promise.all([page, siblingPage].map((targetPage) => targetPage.evaluate(() => {
    (globalThis as unknown as { resetCrossTabPersistenceSignals(): void })
      .resetCrossTabPersistenceSignals();
  })));
  const sourceUid = await page.evaluate(async () => {
    return (globalThis as unknown as {
      signInCrossTabAnonymously(): Promise<string>;
    }).signInCrossTabAnonymously();
  });
  const siblingState = await observeCrossTabAuthAfterPersistenceSignal({
    sourceUid,
    waitForPersistenceSignal: async () => {
      const expectedKey = `firebase:authUser:${config.apiKey}:[DEFAULT]`;
      const deadline = Date.now() + 10_000;
      let signals: AuthStorageSignal[] = [];
      while (Date.now() < deadline) {
        signals = await siblingPage.evaluate(() => {
          return (globalThis as unknown as {
            readCrossTabAuth(): { persistenceSignals: AuthStorageSignal[] };
          }).readCrossTabAuth().persistenceSignals;
        });
        if (signals.some((signal) => authStorageSignalMatches(signal, expectedKey, sourceUid))) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `timed out waiting for Auth storage key '${expectedKey}' carrying uid '${sourceUid}'`,
      );
    },
    readState: () => siblingPage.evaluate(() => {
      return (globalThis as unknown as {
        readCrossTabAuth(): { currentUid: string | null; events: Array<string | null> };
      }).readCrossTabAuth();
    }),
  });
  await page.evaluate(async () => {
    await (globalThis as unknown as { deleteCrossTabUser(): Promise<void> }).deleteCrossTabUser();
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const crossTabBehavior = {
    localSignInPropagatesToSameNamedAppInSiblingTab:
      siblingState.currentUid === sourceUid && siblingState.events.includes(sourceUid),
    propagatedUidMatchesSource: siblingState.currentUid === sourceUid,
  };
  await Promise.all([page, siblingPage].map((targetPage) => targetPage.evaluate(async () => {
    await (globalThis as unknown as { cleanupCrossTabAuth(): Promise<void> }).cleanupCrossTabAuth();
  })));
  const crossTabObservation = {
    name: 'app-production-cross-tab-auth-persistence',
    matrixRow: 'auth #184',
    rowIds: ['auth#184'],
    description:
      'Real-browser production capture for LOCAL Auth persistence synchronization between same-named app instances in sibling tabs, observed for a bounded quiet window after the sibling receives the persistence event.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: firebasePackage.version,
    projectId: config.projectId,
    methodology: {
      startsAfterSiblingPersistenceSignal: true,
      persistenceSignalMatchesDefaultAppKeyAndSourceUid: true,
      quietWindowMs: 5_000,
    },
    behavior: crossTabBehavior,
  };
  writeFileSync(
    CROSS_TAB_OBSERVATION,
    `${JSON.stringify(crossTabObservation, null, 2)}\n`,
  );
  console.log(`[app-production] wrote ${CROSS_TAB_OBSERVATION}`);
  console.log(JSON.stringify(crossTabBehavior));
} finally {
  await browser.close();
  server.stop(true);
}
