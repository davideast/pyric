/**
 * Root `pyric-admin` entry point -- pure re-export barrel matching
 * `firebase-admin` v14.5.1 (`lib/index.js`).
 */
export {
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
  type AdminAppOptions,
  type AppErrorCodeValue,
  type ErrorInfo,
  type HttpResponse,
  type InitializeAdminAppConfig,
  type PyricAdminApp,
  type PyricAdminAppTarget,
  type SandboxAdminApp,
} from './app/index.js';
export { default, default as 'module.exports' } from './admin.js';
