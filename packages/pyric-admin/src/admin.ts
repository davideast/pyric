/**
 * Root `firebase-admin` compatibility facade.
 *
 * Implements top-level service accessors (admin.firestore(), admin.auth(), etc.)
 * and re-exports app lifecycle helpers so standard `import admin from 'firebase-admin'`
 * and `const admin = require('firebase-admin')` work out of the box in the sandbox.
 *
 * As upstream, the `firestore` and `database` accessors also carry their
 * namespace values (`admin.firestore.FieldValue`, `admin.database.ServerValue`).
 * The accessors of services the sandbox does not model are deferred: calling
 * one throws a `PyricDeferredApiError` naming it.
 */
import { deferredExport } from 'pyric/app/internal';
import * as appModule from './app/index.js';
import * as firestoreModule from './firestore/index.js';
import { getAuth } from './auth/index.js';
import { enableLogging, getDatabase, ServerValue } from './database/index.js';
import { getStorage } from './storage/index.js';
import { getMessaging } from './messaging/index.js';

export const credential = {
  cert: appModule.cert,
  applicationDefault: appModule.applicationDefault,
  refreshToken: appModule.refreshToken,
};

export const firestore = Object.assign(
  (app?: appModule.PyricAdminApp) => firestoreModule.getFirestore(app),
  {
    AggregateField: firestoreModule.AggregateField,
    FieldPath: firestoreModule.FieldPath,
    FieldValue: firestoreModule.FieldValue,
    Filter: firestoreModule.Filter,
    GeoPoint: firestoreModule.GeoPoint,
    GrpcStatus: firestoreModule.GrpcStatus,
    setLogFunction: firestoreModule.setLogFunction,
    Timestamp: firestoreModule.Timestamp,
  },
);
export const auth = (app?: appModule.PyricAdminApp) => getAuth(app);
export const database = Object.assign((app?: appModule.PyricAdminApp) => getDatabase(app), {
  enableLogging,
  ServerValue,
});
export const storage = (app?: appModule.PyricAdminApp) => getStorage(app);
export const messaging = (app?: appModule.PyricAdminApp) => getMessaging(app);

const SUBPATH = 'pyric-admin';
export const app = deferredExport(SUBPATH, 'app');
export const appCheck = deferredExport(SUBPATH, 'appCheck');
export const installations = deferredExport(SUBPATH, 'installations');
export const instanceId = deferredExport(SUBPATH, 'instanceId');
export const machineLearning = deferredExport(SUBPATH, 'machineLearning');
export const projectManagement = deferredExport(SUBPATH, 'projectManagement');
export const remoteConfig = deferredExport(SUBPATH, 'remoteConfig');
export const securityRules = deferredExport(SUBPATH, 'securityRules');

const admin = {
  ...appModule,
  credential,
  firestore,
  auth,
  database,
  storage,
  messaging,
  app,
  appCheck,
  installations,
  instanceId,
  machineLearning,
  projectManagement,
  remoteConfig,
  securityRules,
};

export default admin;
