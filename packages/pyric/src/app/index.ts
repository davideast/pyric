/** `pyric/app` — Firebase-compatible app registry selected by package resolution. */
export { SDK_VERSION, onLog, registerVersion, setLogLevel } from './diagnostics.js';
export type { LogCallback, LogEntry, LogLevel, LogOptions } from './diagnostics.js';
export { FirebaseError } from '../sandbox/internal/firebase-error.js';
export {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
} from './registry.js';
export type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
} from './types.js';
