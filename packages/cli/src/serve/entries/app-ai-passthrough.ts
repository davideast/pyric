/** Served `firebase/app`: Pyric client registry with shadow container bridge for production AI pass-through. */
import { bindAppRegistrySandbox } from 'pyric/app/internal';
import { sandbox } from './app-backend.js';
import * as pyricApp from 'pyric/app';
import { shadowedAppRegistry } from '../../register/app-bridge-shadow.js';

bindAppRegistrySandbox(sandbox);

// One shadow implementation for every plane: the register adapters build
// their exports from the same registry.
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
} from 'pyric/app';
export type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  LogCallback,
  LogEntry,
  LogLevel,
  LogOptions,
} from 'pyric/app';
