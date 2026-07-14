/** Firebase-compatible client app registry backed by one local sandbox. */
import type { FirebaseApp, FirebaseAppSettings, FirebaseOptions } from 'firebase/app';
import {
  attachSandboxApp,
  installDefaultAppResolver,
  markSandboxAppDeleted,
} from './runtime.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { initializeSandbox } from '../sandbox/index.js';
import { firebaseOptionsEqual } from './options.js';

const DEFAULT_APP_NAME = '[DEFAULT]';

interface RegistryEntry {
  app: FirebaseApp;
  options: FirebaseOptions;
  settings: Required<Pick<FirebaseAppSettings, 'name' | 'automaticDataCollectionEnabled'>>;
}

const appRegistry = new Map<string, RegistryEntry>();
const deletedApps = new WeakSet<FirebaseApp>();
const appNames = new WeakMap<FirebaseApp, string>();
let backendOptions: FirebaseOptions | undefined;
let backendSandbox: ReturnType<typeof initializeSandbox> | undefined;

/** Internal host seam: bind the exact client registry to an existing sandbox. */
export function bindAppRegistrySandbox(sandbox: ReturnType<typeof initializeSandbox>): void {
  if (backendOptions !== undefined || (backendSandbox !== undefined && backendSandbox !== sandbox)) {
    throw new Error('pyric/app/internal: the app registry sandbox is already bound');
  }
  backendSandbox = sandbox;
}

function appError(code: string, message: string): FirebaseError {
  return new FirebaseError(`app/${code}`, `Firebase: ${message} (app/${code}).`);
}

function noAppError(name: string): FirebaseError {
  return appError('no-app', `No Firebase App '${name}' has been created - call initializeApp() first`);
}

function duplicateAppError(name: string): FirebaseError {
  return appError('duplicate-app', `Firebase App named '${name}' already exists with different options or config`);
}

function appDeletedError(name: string): FirebaseError {
  return appError('app-deleted', `Firebase App named '${name}' already deleted`);
}

function noOptionsError(): FirebaseError {
  return appError('no-options', 'Need to provide options, when not being deployed to hosting via source.');
}

function multipleConfigsError(): FirebaseError {
  return appError(
    'multiple-configs-not-supported',
    'Pyric currently supports one Firebase configuration per runtime',
  );
}

function createFirebaseApp(
  name: string,
  options: FirebaseOptions,
  automaticDataCollectionEnabled: boolean,
): FirebaseApp {
  let automatic = automaticDataCollectionEnabled;
  let app: FirebaseApp;
  const assertAlive = (): void => {
    if (deletedApps.has(app)) throw appDeletedError(name);
  };
  app = Object.defineProperties({}, {
    name: {
      enumerable: true,
      get() {
        assertAlive();
        return name;
      },
    },
    options: {
      enumerable: true,
      get() {
        assertAlive();
        return options;
      },
    },
    automaticDataCollectionEnabled: {
      enumerable: true,
      get() {
        assertAlive();
        return automatic;
      },
      set(value: boolean) {
        assertAlive();
        automatic = value;
      },
    },
  }) as FirebaseApp;
  appNames.set(app, name);
  return app;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cloneValue(child)]),
    ) as T;
  }
  return value;
}

function normalizeSettings(raw: string | FirebaseAppSettings | undefined): Required<Pick<FirebaseAppSettings, 'name' | 'automaticDataCollectionEnabled'>> {
  const settings = typeof raw === 'string' ? { name: raw } : raw ?? {};
  const name = settings.name ?? DEFAULT_APP_NAME;
  if (typeof name !== 'string' || name.length === 0) {
    throw appError('bad-app-name', `Illegal App name: '${String(name)}'`);
  }
  return {
    name,
    automaticDataCollectionEnabled: settings.automaticDataCollectionEnabled ?? true,
  };
}

export function initializeApp(
  options?: FirebaseOptions,
  rawSettings?: string | FirebaseAppSettings,
): FirebaseApp {
  if (options === undefined) throw noOptionsError();
  const settings = normalizeSettings(rawSettings);
  const optionsSnapshot = cloneValue(options);
  const existing = appRegistry.get(settings.name);
  if (existing) {
    if (
      firebaseOptionsEqual(existing.options, optionsSnapshot)
      && firebaseOptionsEqual(existing.settings, settings)
    ) {
      return existing.app;
    }
    throw duplicateAppError(settings.name);
  }

  if (backendOptions === undefined) {
    backendOptions = cloneValue(optionsSnapshot);
    backendSandbox ??= initializeSandbox();
  } else if (!firebaseOptionsEqual(backendOptions, optionsSnapshot)) {
    throw multipleConfigsError();
  }

  const app = createFirebaseApp(
    settings.name,
    cloneValue(optionsSnapshot),
    settings.automaticDataCollectionEnabled,
  );
  // The default app is the sandbox's ambient client session. Named apps get
  // independent sessions while sharing the same data/user-store backend.
  attachSandboxApp(
    app,
    backendSandbox!,
    settings.name === DEFAULT_APP_NAME ? backendSandbox! : undefined,
  );
  appRegistry.set(settings.name, { app, options: optionsSnapshot, settings });
  return app;
}

export function getApp(name: string = DEFAULT_APP_NAME): FirebaseApp {
  const entry = appRegistry.get(name);
  if (!entry) throw noAppError(name);
  return entry.app;
}

export function getApps(): FirebaseApp[] {
  return Array.from(appRegistry.values(), ({ app }) => app);
}

export async function deleteApp(app: FirebaseApp): Promise<void> {
  const name = appNames.get(app) ?? app.name;
  if (deletedApps.has(app)) throw appDeletedError(name);
  const entry = appRegistry.get(name);
  if (entry?.app === app) appRegistry.delete(name);
  deletedApps.add(app);
  await markSandboxAppDeleted(app);
}

/** Test-only module reset; deliberately absent from the public app barrel. */
export async function resetAppRegistryForTests(): Promise<void> {
  await Promise.all([...appRegistry.values()].map(({ app }) => markSandboxAppDeleted(app)));
  appRegistry.clear();
  backendSandbox?.dispose();
  backendSandbox = undefined;
  backendOptions = undefined;
}

installDefaultAppResolver(getApp);
