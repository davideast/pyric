import 'fake-indexeddb/auto';
import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deleteApp, initializeApp } from 'pyric/app';
import { getAuth, signInAnonymously, signOut } from 'pyric/auth';
import { doc, getDoc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';
import { get, getDatabase, onValue, ref, set } from 'pyric/database';
import { setRules } from 'pyric/sandbox/firestore';
import { sandboxForApp } from '../../dist/app/runtime.js';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

const observation = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../../../conformance/observations/app/app-production-multi-app-topology.json',
), 'utf8')).behavior as Record<string, unknown>;

const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 10));

beforeEach(async () => {
  await resetAppRegistryForTests();
});

test('replays production equal-config app, Auth-session, and deletion-listener topology', async () => {
  const options = { projectId: 'production-multi-app-oracle' };
  const authAApp = initializeApp(options);
  const authBApp = initializeApp({ ...options }, 'auth-b');
  const authA = getAuth(authAApp);
  const authB = getAuth(authBApp);
  const authAUser = (await signInAnonymously(authA)).user;
  const bStayedSignedOut = authB.currentUser === null;
  const authBUser = (await signInAnonymously(authB)).user;
  const distinctSessions = authA.currentUser?.uid === authAUser.uid
    && authB.currentUser?.uid === authBUser.uid
    && authAUser.uid !== authBUser.uid;
  await signOut(authA);
  const bStayedSignedIn = authB.currentUser?.uid === authBUser.uid;
  await deleteApp(authAApp);
  await deleteApp(authBApp);

  const retainedAuthApp = initializeApp(options, 'retained-auth');
  const retainedAuth = getAuth(retainedAuthApp);
  await deleteApp(retainedAuthApp);
  let retainedAuthSignInAfterDelete: { threw: boolean; code: string | null };
  try {
    await signInAnonymously(retainedAuth);
    retainedAuthSignInAfterDelete = { threw: false, code: null };
  } catch (error) {
    retainedAuthSignInAfterDelete = {
      threw: true,
      code: (error as { code?: string }).code ?? null,
    };
  }

  const dataAApp = initializeApp(options);
  const dataBApp = initializeApp({ ...options }, 'data-b');
  const dataAAuth = getAuth(dataAApp);
  const dataBAuth = getAuth(dataBApp);
  await signInAnonymously(dataAAuth);
  await signInAnonymously(dataBAuth);
  const sandbox = sandboxForApp(dataAApp);
  setRules(sandbox, `rules_version = '2'; service cloud.firestore {
    match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } }
  }`);

  const firestoreA = getFirestore(dataAApp);
  const firestoreB = getFirestore(dataBApp);
  const firestoreARef = doc(firestoreA, 'shared/firestore');
  const firestoreBRef = doc(firestoreB, 'shared/firestore');
  await setDoc(firestoreARef, { value: 'from-a' });
  const firestoreShared = (await getDoc(firestoreBRef)).data()?.value === 'from-a';
  const firestoreAValues: unknown[] = [];
  const firestoreBValues: unknown[] = [];
  const firestoreAErrors: Array<{ code?: string }> = [];
  const firestoreBErrors: unknown[] = [];
  onSnapshot(firestoreARef, (snap) => firestoreAValues.push(snap.data()?.value ?? null),
    (error) => firestoreAErrors.push(error as { code?: string }));
  const stopFirestoreB = onSnapshot(firestoreBRef,
    (snap) => firestoreBValues.push(snap.data()?.value ?? null),
    (error) => firestoreBErrors.push(error));
  await tick();

  const databaseA = getDatabase(dataAApp);
  const databaseB = getDatabase(dataBApp);
  const databaseARef = ref(databaseA, 'shared/database');
  const databaseBRef = ref(databaseB, 'shared/database');
  const databaseAValues: unknown[] = [];
  const databaseBValues: unknown[] = [];
  onValue(databaseARef, (snap) => databaseAValues.push(snap.val()));
  const stopDatabaseB = onValue(databaseBRef, (snap) => databaseBValues.push(snap.val()));
  await set(databaseARef, 'from-a');
  const databaseShared = (await get(databaseBRef)).val() === 'from-a';

  const firestoreABeforeDelete = firestoreAValues.length;
  const databaseABeforeDelete = databaseAValues.length;
  await deleteApp(dataAApp);
  await setDoc(firestoreBRef, { value: 'after-delete' });
  await set(databaseBRef, 'after-delete');
  await tick();

  const actual = {
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
    deletedAppFirestoreListenerOutcome: firestoreAValues.length > firestoreABeforeDelete
      ? 'delivered-after-delete'
      : firestoreAErrors.length > 0
        ? 'errored-after-delete'
        : 'stopped-silently',
    deletedAppFirestoreListenerErrorCodes: firestoreAErrors.map((error) => error.code),
    deletedAppRtdbListenerStopped: databaseAValues.length === databaseABeforeDelete,
    siblingFirestoreListenerSurvived:
      firestoreBValues.includes('after-delete') && firestoreBErrors.length === 0,
    siblingRtdbListenerSurvived: databaseBValues.includes('after-delete'),
  };

  stopFirestoreB();
  stopDatabaseB();
  await deleteApp(dataBApp);
  expect(actual).toEqual(observation);
});
