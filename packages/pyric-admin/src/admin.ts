/**
 * Root `firebase-admin` compatibility facade (`lib/index.js`, v14.5.1).
 *
 * `firebase-admin@14` removed the legacy v8 namespace accessors (`admin.auth`,
 * `admin.firestore`, `admin.apps`, etc.). The root entry now re-exports the 11
 * `firebase-admin/app` value symbols and binds them on the default export for
 * CommonJS `require('firebase-admin')` and ESM `import admin from 'firebase-admin'`.
 */
import {
  AppErrorCode,
  FirebaseAppError,
  FirebaseError,
  SDK_VERSION,
  applicationDefault,
  cert,
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  refreshToken,
} from './app/index.js';

const admin = {
  AppErrorCode,
  FirebaseAppError,
  FirebaseError,
  SDK_VERSION,
  applicationDefault,
  cert,
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  refreshToken,
};

// Match CJS/ESM interop where `admin.default === admin`.
Object.defineProperty(admin, 'default', {
  get: () => admin,
  configurable: true,
});

export default admin;
