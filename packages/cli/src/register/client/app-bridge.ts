/**
 * `firebase/app` on the Node host client (#1082) when production AI
 * pass-through is active: the Node host client's registry, each app shadowed
 * by a real Firebase app for the real `firebase/ai`.
 */
import * as pyricApp from './app.js';
import { shadowedAppRegistry } from '../app-bridge-shadow.js';

const registry = shadowedAppRegistry(pyricApp);

export const initializeApp = registry.initializeApp;
export const getApp = registry.getApp;
export const getApps = registry.getApps;
export const deleteApp = registry.deleteApp;

export {
  FirebaseError,
  SDK_VERSION,
  onLog,
  registerVersion,
  setLogLevel,
} from './app.js';
export type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  LogCallback,
  LogEntry,
  LogLevel,
  LogOptions,
} from './app.js';
