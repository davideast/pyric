/** Served `firebase/app`: Pyric client and server app registries with shadow container bridge for production AI pass-through. */
import { bindAppRegistrySandbox } from 'pyric/app/internal';
import * as pyricApp from 'pyric/app';
import { shadowedAppRegistry } from '../../register/app-bridge-shadow.js';
import { sandbox } from './app-backend.js';

// One shadow implementation for every plane: the register adapters build
// their exports from the same registry.
const registry = shadowedAppRegistry({
  initializeApp(options, rawSettings) {
    bindAppRegistrySandbox(sandbox);
    return pyricApp.initializeApp(options, rawSettings);
  },
  initializeServerApp(options, rawSettings) {
    bindAppRegistrySandbox(sandbox);
    return pyricApp.initializeServerApp(options as pyricApp.FirebaseOptions, rawSettings);
  },
  getApp: pyricApp.getApp,
  getApps: pyricApp.getApps,
  deleteApp: pyricApp.deleteApp,
});

export const initializeApp = registry.initializeApp;
export const initializeServerApp = registry.initializeServerApp;
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
  FirebaseServerApp,
  FirebaseServerAppSettings,
  LogCallback,
  LogEntry,
  LogLevel,
  LogOptions,
} from 'pyric/app';

export * from './unsupported/app.js';
