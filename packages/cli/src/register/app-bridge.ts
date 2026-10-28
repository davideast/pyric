/** Node register adapter for canonical `firebase/app` imports when production AI pass-through is active. */
import * as pyricApp from 'pyric/app/register';
import { shadowedAppRegistry } from './app-bridge-shadow.js';

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
} from 'pyric/app/register';
export type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  LogCallback,
  LogEntry,
  LogLevel,
  LogOptions,
} from 'pyric/app/register';
