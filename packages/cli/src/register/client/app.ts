/**
 * `firebase/app` in a Node process `@pyric/cli/register` activated against a
 * remote host (#1082): the exact Pyric client registry, bound by the bootstrap
 * to no sandbox. The served service modules beside this one reach the Node
 * host through each app's own hosted connection.
 */
import './bootstrap.js';
import {
  initializeServerApp as initializePyricServerApp,
  type FirebaseApp,
  type FirebaseOptions,
  type FirebaseServerApp,
  type FirebaseServerAppSettings,
} from 'pyric/app';
import { recordRemoteServerAppToken } from './server-app-session.js';

export {
  deleteApp,
  FirebaseError,
  getApp,
  getApps,
  initializeApp,
  onLog,
  registerVersion,
  SDK_VERSION,
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

export function initializeServerApp(
  options: FirebaseOptions | FirebaseApp | undefined,
  config?: FirebaseServerAppSettings,
): FirebaseServerApp;
export function initializeServerApp(
  config?: FirebaseServerAppSettings,
): FirebaseServerApp;
export function initializeServerApp(
  optionsOrConfig?: FirebaseOptions | FirebaseApp | FirebaseServerAppSettings,
  config?: FirebaseServerAppSettings,
): FirebaseServerApp {
  const serverApp = initializePyricServerApp(optionsOrConfig as FirebaseOptions, config);
  recordRemoteServerAppToken(serverApp);
  return serverApp;
}
