/**
 * Node register adapter for canonical `firebase/app` imports.
 *
 * The register hook resolves `firebase/app` here instead of directly to the
 * strict `pyric/app` entry. Firebase configuration is retained for compatible
 * property reads but never selects or initializes a production backend.
 */
import { initializeSandbox } from '../sandbox/index.js';
import {
  DEFAULT_APP_NAME,
  initializeApp as initializeSandboxApp,
  type PyricApp,
} from './index.js';

export * from './index.js';

export interface FirebaseOptions {
  apiKey?: string;
  authDomain?: string;
  databaseURL?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
}

export interface FirebaseAppSettings {
  name?: string;
  automaticDataCollectionEnabled?: boolean;
}

export type RegisterFirebaseApp = PyricApp & {
  readonly options: FirebaseOptions;
  automaticDataCollectionEnabled: boolean;
};

const processSandbox = initializeSandbox();

export function initializeApp(
  options: FirebaseOptions = {},
  rawConfig: string | FirebaseAppSettings = {},
): RegisterFirebaseApp {
  const config = typeof rawConfig === 'string' ? { name: rawConfig } : rawConfig;
  const name = config.name ?? DEFAULT_APP_NAME;
  const app = initializeSandboxApp({ sandbox: processSandbox }, name) as RegisterFirebaseApp;

  if (!('options' in app)) {
    Object.assign(app, {
      options,
      automaticDataCollectionEnabled: config.automaticDataCollectionEnabled ?? true,
    });
  }
  return app;
}
