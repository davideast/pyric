/**
 * Root `firebase-admin` compatibility facade.
 *
 * Implements top-level service accessors (admin.firestore(), admin.auth(), etc.)
 * and re-exports app lifecycle helpers so standard `import admin from 'firebase-admin'`
 * and `const admin = require('firebase-admin')` work out of the box in the sandbox.
 *
 * As upstream, the `firestore` and `database` accessors also carry their
 * namespace values (`admin.firestore.FieldValue`, `admin.database.ServerValue`).
 * `admin.app(name?)` returns an initialized app and `admin.apps` lists them,
 * so `if (!admin.apps.length) admin.initializeApp()` works. Accessors for
 * unmodeled services return their `App`-bound handle just like their modular
 * `get<Service>(app?)` counterparts; invoking methods on those handles fails
 * with `PyricDeferredApiError` naming the method and subpath.
 */
import * as appModule from './app/index.js';
import * as firestoreModule from './firestore/index.js';
import { getAuth } from './auth/index.js';
import { enableLogging, getDatabase, ServerValue } from './database/index.js';
import { getStorage } from './storage/index.js';
import { getMessaging } from './messaging/index.js';
import { getAppCheck } from './app-check/index.js';
import { getInstallations } from './installations/index.js';
import { getInstanceId } from './instance-id/index.js';
import { getMachineLearning } from './machine-learning/index.js';
import { getProjectManagement } from './project-management/index.js';
import { getRemoteConfig } from './remote-config/index.js';
import { getSecurityRules } from './security-rules/index.js';

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

/** As upstream `admin.app(name?)`: the named app, or the default app. */
export const app = (name?: string) => appModule.getApp(name);

export const appCheck = (app?: appModule.PyricAdminApp) => getAppCheck(app);
export const installations = (app?: appModule.PyricAdminApp) => getInstallations(app);
export const instanceId = (app?: appModule.PyricAdminApp) => getInstanceId(app);
export const machineLearning = (app?: appModule.PyricAdminApp) => getMachineLearning(app);
export const projectManagement = (app?: appModule.PyricAdminApp) => getProjectManagement(app);
export const remoteConfig = (app?: appModule.PyricAdminApp) => getRemoteConfig(app);
export const securityRules = (app?: appModule.PyricAdminApp) => getSecurityRules(app);

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
  /** As upstream `admin.apps`: every initialized app, read when accessed. */
  get apps() {
    return appModule.getApps();
  },
};

export default admin;
