/** `pyric/app` — sandbox-only mirror selected by package resolution. */
export { APP_TARGET, isSandboxApp } from '../sandbox/internal/app-handle.js';
export { SDK_VERSION, onLog, registerVersion, setLogLevel } from './diagnostics.js';
export type { LogCallback, LogEntry, LogLevel, LogOptions } from './diagnostics.js';
export { FirebaseError } from './firebase-error.js';
export {
  DEFAULT_APP_NAME,
  deleteApp,
  getApp,
  getApps,
  initializeApp,
} from './registry.js';
export type {
  InitializeAppConfig,
  PyricApp,
  PyricAppTarget,
  SandboxApp,
} from './types.js';
