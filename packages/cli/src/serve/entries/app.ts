/** Served `firebase/app`: the exact Pyric client registry over the page runtime. */
import { bindAppRegistrySandbox } from 'pyric/app/internal';
import {
  initializeApp as initializeRegistryApp,
  type FirebaseApp,
  type FirebaseAppSettings,
  type FirebaseOptions,
} from 'pyric/app';
import { sandbox } from './app-backend.js';

// Keep this entry free of dynamic imports: ServiceWorkerGlobalScope supports
// static module imports but rejects dynamic import(). The attached sandbox is
// only the app handle's realm-local placeholder; served service calls route to
// the SharedWorker (directly in Window, via BroadcastChannel in a real SW).
export function initializeApp(
  options?: FirebaseOptions,
  rawSettings?: string | FirebaseAppSettings,
): FirebaseApp {
  bindAppRegistrySandbox(sandbox);
  return initializeRegistryApp(options, rawSettings);
}

export * from 'pyric/app';

export * from './unsupported/app.js';
