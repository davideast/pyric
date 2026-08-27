/**
 * Root `firebase-admin` compatibility facade.
 *
 * Implements top-level service accessors (admin.firestore(), admin.auth(), etc.)
 * and re-exports app lifecycle helpers so standard `import admin from 'firebase-admin'`
 * and `const admin = require('firebase-admin')` work out of the box in the sandbox.
 */
import * as appModule from './app/index.js';
import { getFirestore } from './firestore/index.js';
import { getAuth } from './auth/index.js';
import { getDatabase } from './database/index.js';
import { getStorage } from './storage/index.js';
import { getMessaging } from './messaging/index.js';

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
