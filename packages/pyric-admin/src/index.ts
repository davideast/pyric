/**
 * Root `pyric-admin` entry point — mirrors `firebase-admin`'s root package export.
 *
 * Exposes top-level modular helpers as well as the default `admin` namespace,
 * allowing unmodified `import admin from 'firebase-admin'` and
 * `import { initializeApp, firestore, auth } from 'firebase-admin'` to resolve cleanly.
 */
import * as appModule from './app/index.js';
import { getFirestore } from './firestore/index.js';
import { getAuth } from './auth/index.js';
import { getDatabase } from './database/index.js';
import { getStorage } from './storage/index.js';
import { getMessaging } from './messaging/index.js';

export * from './app/index.js';
export { getFirestore } from './firestore/index.js';
export { getAuth } from './auth/index.js';
export { getDatabase } from './database/index.js';
export { getStorage } from './storage/index.js';
export { getMessaging } from './messaging/index.js';

export const credential = {
  cert: appModule.cert,
  applicationDefault: appModule.applicationDefault,
  refreshToken: (token: string) => ({
    [Symbol.for('pyric.admin.credential')]: 'refreshToken',
    token,
  }),
};

export const firestore = (app?: appModule.PyricAdminApp) => getFirestore(app);
export const auth = (app?: appModule.PyricAdminApp) => getAuth(app);
export const database = (app?: appModule.PyricAdminApp) => getDatabase(app);
export const storage = (app?: appModule.PyricAdminApp) => getStorage(app);
export const messaging = (app?: appModule.PyricAdminApp) => getMessaging(app);

const admin = {
  ...appModule,
  credential,
  firestore,
  auth,
  database,
  storage,
  messaging,
};

export default admin;
