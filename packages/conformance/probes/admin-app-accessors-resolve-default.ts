import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'With a default app initialized, firebase-admin getAuth()/getFirestore()/getStorage() called with NO arg resolve the default app and return the service handle (constructor names Auth/Firestore/Storage). getDatabase() also resolves the default app but additionally requires a databaseURL (see admin-app-getdatabase-missing-url). rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    initializeApp();
    let allResolveDefaultNoArg = true;
    let getAuthReturnsConstructor: string | undefined;
    let getFirestoreReturnsConstructor: string | undefined;
    let getStorageReturnsConstructor: string | undefined;
    try {
      getAuthReturnsConstructor = getAuth().constructor.name;
    } catch {
      allResolveDefaultNoArg = false;
    }
    try {
      getFirestoreReturnsConstructor = getFirestore().constructor.name;
    } catch {
      allResolveDefaultNoArg = false;
    }
    try {
      getStorageReturnsConstructor = getStorage().constructor.name;
    } catch {
      allResolveDefaultNoArg = false;
    }
    return {
      getAuthReturnsConstructor,
      getFirestoreReturnsConstructor,
      getStorageReturnsConstructor,
      allResolveDefaultNoArg,
    };
  },
};
