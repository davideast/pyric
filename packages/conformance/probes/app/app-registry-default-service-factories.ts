import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';

const OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-app-registry-defaults',
  appId: '1:0:web:0',
  databaseURL: 'https://demo-app-registry-defaults-default-rtdb.firebaseio.com',
  storageBucket: 'demo-app-registry-defaults.appspot.com',
};

export const probe: Probe = {
  description:
    'No-argument Firebase service factories resolve their service from the registered default app.',
  matrixRow: 'app #22',
  rowIds: ['app#22'],
  async observe() {
    const app = initializeApp(OPTIONS);
    return {
      authUsesDefaultApp: getAuth().app === app,
      firestoreUsesDefaultApp: getFirestore().app === app,
      databaseUsesDefaultApp: getDatabase().app === app,
      storageUsesDefaultApp: getStorage().app === app,
    };
  },
};
