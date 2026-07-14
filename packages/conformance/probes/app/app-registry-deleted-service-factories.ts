import { deleteApp, initializeApp } from 'firebase/app';
import { getAI } from 'firebase/ai';
import { getAuth, signOut } from 'firebase/auth';
import { getDatabase, ref as databaseRef } from 'firebase/database';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { getStorage, ref as storageRef } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';

const OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-app-registry-deleted-services',
  appId: '1:0:web:0',
  databaseURL: 'https://demo-app-registry-deleted-services-default-rtdb.firebaseio.com',
  storageBucket: 'demo-app-registry-deleted-services.appspot.com',
};

function outcome(run: () => unknown, expectedApp = deletedApp): Record<string, unknown> {
  try {
    const value = run() as { app?: unknown };
    return { threw: false, usesDeletedApp: value?.app === expectedApp };
  } catch (error) {
    const candidate = error as Error & { code?: string };
    return {
      threw: true,
      errorName: candidate.constructor.name,
      isError: candidate instanceof Error,
      code: candidate.code ?? null,
      message: candidate.message,
    };
  }
}

async function asyncOutcome(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
    return { threw: false };
  } catch (error) {
    const candidate = error as Error & { code?: string };
    return {
      threw: true,
      errorName: candidate.constructor.name,
      isError: candidate instanceof Error,
      code: candidate.code ?? null,
      message: candidate.message,
    };
  }
}

let deletedApp: ReturnType<typeof initializeApp>;

export const probe: Probe = {
  description:
    'Service factories called with a deleted FirebaseApp either reject with app/app-deleted or preserve the observed Firebase AI behavior.',
  matrixRow: 'app #25',
  rowIds: ['app#25'],
  async observe() {
    deletedApp = initializeApp(OPTIONS, 'deleted-services');
    const retainedApp = initializeApp({ ...OPTIONS }, 'retained-services');
    const auth = getAuth(retainedApp);
    const firestore = getFirestore(retainedApp);
    const firestoreDoc = doc(firestore, 'notes/note-01');
    const database = getDatabase(retainedApp);
    const storage = getStorage(retainedApp);
    await deleteApp(deletedApp);
    await deleteApp(retainedApp);
    return {
      auth: outcome(() => getAuth(deletedApp)),
      firestore: outcome(() => getFirestore(deletedApp)),
      database: outcome(() => getDatabase(deletedApp)),
      storage: outcome(() => getStorage(deletedApp)),
      ai: outcome(() => getAI(deletedApp)),
      cachedAuthFactory: outcome(() => getAuth(retainedApp), retainedApp),
      cachedFirestoreFactory: outcome(() => getFirestore(retainedApp), retainedApp),
      cachedDatabaseFactory: outcome(() => getDatabase(retainedApp), retainedApp),
      cachedStorageFactory: outcome(() => getStorage(retainedApp), retainedApp),
      retainedAuthSignOut: await asyncOutcome(() => signOut(auth)),
      retainedFirestoreGet: await asyncOutcome(() => getDoc(firestoreDoc)),
      retainedDatabaseRef: outcome(() => databaseRef(database, 'notes/note-01')),
      retainedStorageRef: outcome(() => storageRef(storage, 'notes/note-01').toString()),
    };
  },
};
