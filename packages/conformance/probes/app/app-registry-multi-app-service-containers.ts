import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase, ref as databaseRef } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getStorage, ref as storageRef } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';

const OPTS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-app-registry',
  appId: '1:0:web:0',
  databaseURL: 'https://demo-app-registry-default-rtdb.firebaseio.com',
  storageBucket: 'demo-app-registry.appspot.com',
};

export const probe: Probe = {
  description:
    'Equal-config named Firebase apps own distinct Auth, Firestore, RTDB, and Storage service containers associated with their initiating app while resolving equal RTDB and Storage backend locators.',
  matrixRow: 'app #18',
  rowIds: ['app#18'],
  async observe() {
    const a = initializeApp(OPTS, 'app-a');
    const b = initializeApp({ ...OPTS }, 'app-b');
    const authA = getAuth(a);
    const authB = getAuth(b);
    const firestoreA = getFirestore(a);
    const firestoreB = getFirestore(b);
    const databaseA = getDatabase(a);
    const databaseB = getDatabase(b);
    const storageA = getStorage(a);
    const storageB = getStorage(b);
    return {
      authDistinct: authA !== authB,
      authAppsCorrect: authA.app === a && authB.app === b,
      firestoreDistinct: firestoreA !== firestoreB,
      firestoreAppsCorrect: firestoreA.app === a && firestoreB.app === b,
      databaseDistinct: databaseA !== databaseB,
      databaseAppsCorrect: databaseA.app === a && databaseB.app === b,
      databaseLocatorsEqual: databaseRef(databaseA, 'probe').toString() === databaseRef(databaseB, 'probe').toString(),
      storageDistinct: storageA !== storageB,
      storageAppsCorrect: storageA.app === a && storageB.app === b,
      storageLocatorsEqual: storageRef(storageA, 'probe').toString() === storageRef(storageB, 'probe').toString(),
    };
  },
};
