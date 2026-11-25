/** Firebase-compatible client and server app registries backed by one local sandbox. */
import type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  FirebaseServerApp,
  FirebaseServerAppSettings,
} from './types.js';
import {
  attachRefusedSandboxApp,
  attachSandboxApp,
  createAppSession,
  installDefaultAppResolver,
  markSandboxAppDeleted,
} from './runtime.js';
import {
  authStateFromServerIdToken,
  computeServerAppName,
  defaultAppOptionsFromEnvironment,
  isBrowserWindowEnvironment,
  isFirebaseAppObject,
  isFirebaseServerAppSettingsObject,
  validateServerTokenTTL,
} from './server-app-tokens.js';
import { recordServerAppCheckToken } from '../sandbox/internal/app-check-activation.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { initializeSandbox } from '../sandbox/index.js';
import { firebaseOptionsEqual } from './options.js';

const DEFAULT_APP_NAME = '[DEFAULT]';

interface RegistryEntry {
  app: FirebaseApp;
  options: FirebaseOptions;
  settings: Required<Pick<FirebaseAppSettings, 'name' | 'automaticDataCollectionEnabled'>>;
}

interface ServerRegistryEntry {
  app: FirebaseServerApp;
  incRefCount(derefTarget: object | undefined): void;
  decRefCount(): number;
}

const appRegistry = new Map<string, RegistryEntry>();
const serverAppRegistry = new Map<string, ServerRegistryEntry>();
const deletedApps = new WeakSet<FirebaseApp>();
const deletedServerApps = new WeakSet<FirebaseApp>();
const appNames = new WeakMap<FirebaseApp, string>();
const serverAppNames = new WeakMap<FirebaseApp, string>();
let backendOptions: FirebaseOptions | undefined;
let backendSandbox: ReturnType<typeof initializeSandbox> | undefined;
let ownsBackendSandbox = false;
let backendRefusal: (() => Error) | undefined;

function isBoundToOtherBackend(sandbox: ReturnType<typeof initializeSandbox>): boolean {
  if (backendRefusal !== undefined) return true;
  if (backendSandbox !== undefined) return backendSandbox !== sandbox;
  return backendOptions !== undefined;
}

/** Internal host seam: bind the exact client registry to an existing sandbox. */
export function bindAppRegistrySandbox(sandbox: ReturnType<typeof initializeSandbox>): void {
  if (isBoundToOtherBackend(sandbox)) {
    throw new Error('pyric/app/internal: the app registry sandbox is already bound');
  }
  if (backendSandbox === sandbox) return;
  backendSandbox = sandbox;
  ownsBackendSandbox = false;
}

/** Internal host seam: apps get no sandbox; every service call raises `refusal()`. */
export function bindAppRegistryRefusal(refusal: () => Error): void {
  if (backendOptions !== undefined || backendSandbox !== undefined) {
    throw new Error('pyric/app/internal: the app registry sandbox is already bound');
  }
  backendRefusal = refusal;
}

function appError(code: string, message: string): FirebaseError {
  return new FirebaseError(`app/${code}`, `Firebase: ${message} (app/${code}).`);
}

function noAppError(name: string): FirebaseError {
  return appError('no-app', `No Firebase App '${name}' has been created - call initializeApp() first`);
}

function duplicateAppError(
  name: string,
  mismatchedParam: 'options' | 'config',
  oldValue: unknown,
  newValue: unknown,
): FirebaseError {
  const values = `Existing: '${JSON.stringify(oldValue)}'. New: '${JSON.stringify(newValue)}'.`;
  return appError(
    'duplicate-app',
    `Firebase App named '${name}' already exists with different ${mismatchedParam}. ${values}`,
  );
}

function appDeletedError(name: string): FirebaseError {
  return appError('app-deleted', `Firebase App named '${name}' already deleted`);
}

function serverAppDeletedError(): FirebaseError {
  return appError('server-app-deleted', 'Firebase Server App has been deleted');
}

function noOptionsError(): FirebaseError {
  return appError('no-options', 'Need to provide options, when not being deployed to hosting via source.');
}

function invalidServerAppEnvironmentError(): FirebaseError {
  return appError(
    'invalid-server-app-environment',
    'FirebaseServerApp is not for use in browser environments.',
  );
}

function finalizationRegistryNotSupportedError(): FirebaseError {
  return appError(
    'finalization-registry-not-supported',
    'FirebaseServerApp deleteOnDeref field defined but the JS runtime does not support FinalizationRegistry.',
  );
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

function createFirebaseServerApp(
  name: string,
  options: FirebaseOptions,
  automaticDataCollectionEnabled: boolean,
  settings: FirebaseServerAppSettings,
): FirebaseServerApp {
  let automatic = automaticDataCollectionEnabled;
  let app: FirebaseServerApp;
  const assertAlive = (): void => {
    if (deletedServerApps.has(app)) throw serverAppDeletedError();
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
    settings: {
      enumerable: true,
      get() {
        assertAlive();
        return settings;
      },
    },
    toJSON: {
      enumerable: false,
      value() {
        return undefined;
      },
    },
  }) as FirebaseServerApp;
  serverAppNames.set(app, name);
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

function normalizeSettings(
  raw: string | FirebaseAppSettings | undefined,
): Required<Pick<FirebaseAppSettings, 'name' | 'automaticDataCollectionEnabled'>> {
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

function ensureBackendForOptions(
  optionsSnapshot: FirebaseOptions,
): { refusal: (() => Error) | undefined; sandbox: ReturnType<typeof initializeSandbox> | undefined } {
  const refusal = backendRefusal;
  const isRefused = refusal !== undefined;
  if (backendOptions === undefined) {
    backendOptions = cloneValue(optionsSnapshot);
    if (!isRefused && backendSandbox === undefined) {
      backendSandbox = initializeSandbox();
      ownsBackendSandbox = true;
    }
  } else if (!firebaseOptionsEqual(backendOptions, optionsSnapshot)) {
    throw multipleConfigsError();
  }
  return { refusal, sandbox: backendSandbox };
}

export function initializeApp(
  options?: FirebaseOptions,
  rawSettings?: string | FirebaseAppSettings,
): FirebaseApp {
  const resolvedOptions = options ?? defaultAppOptionsFromEnvironment();
  if (resolvedOptions === undefined) throw noOptionsError();
  const settings = normalizeSettings(rawSettings);
  const optionsSnapshot = cloneValue(resolvedOptions);
  const existing = appRegistry.get(settings.name);
  if (existing) {
    if (!firebaseOptionsEqual(existing.options, optionsSnapshot)) {
      throw duplicateAppError(settings.name, 'options', existing.options, optionsSnapshot);
    }
    if (!firebaseOptionsEqual(existing.settings, settings)) {
      throw duplicateAppError(settings.name, 'config', existing.settings, settings);
    }
    return existing.app;
  }

  const { refusal, sandbox } = ensureBackendForOptions(optionsSnapshot);
  const app = createFirebaseApp(
    settings.name,
    cloneValue(optionsSnapshot),
    settings.automaticDataCollectionEnabled,
  );
  if (refusal !== undefined) {
    attachRefusedSandboxApp(app, refusal);
  } else if (sandbox !== undefined) {
    // The default app is the sandbox's ambient client session. Named apps get
    // independent sessions while sharing the same data/user-store backend.
    const defaultSession = settings.name === DEFAULT_APP_NAME ? sandbox : undefined;
    attachSandboxApp(app, sandbox, defaultSession);
  }
  appRegistry.set(settings.name, { app, options: optionsSnapshot, settings });
  return app;
}

export function initializeServerApp(
  options: FirebaseOptions | FirebaseApp | undefined,
  config?: FirebaseServerAppSettings,
): FirebaseServerApp;
export function initializeServerApp(
  config?: FirebaseServerAppSettings,
): FirebaseServerApp;
export function initializeServerApp(
  optionsOrConfig?: FirebaseOptions | FirebaseApp | FirebaseServerAppSettings,
  rawServerConfig?: FirebaseServerAppSettings,
): FirebaseServerApp {
  if (isBrowserWindowEnvironment()) {
    throw invalidServerAppEnvironmentError();
  }
  let rawOptions: FirebaseOptions | undefined;
  let serverSettings: FirebaseServerAppSettings = rawServerConfig ? { ...rawServerConfig } : {};
  if (optionsOrConfig !== undefined && optionsOrConfig !== null) {
    if (isFirebaseAppObject(optionsOrConfig)) {
      rawOptions = optionsOrConfig.options;
    } else if (isFirebaseServerAppSettingsObject(optionsOrConfig)) {
      serverSettings = { ...optionsOrConfig };
    } else {
      rawOptions = optionsOrConfig;
    }
  }

  let automaticDataCollection = true;
  if (serverSettings.automaticDataCollectionEnabled !== undefined) {
    automaticDataCollection = serverSettings.automaticDataCollectionEnabled;
  }
  serverSettings.automaticDataCollectionEnabled = automaticDataCollection;

  const resolvedOptions = rawOptions ?? defaultAppOptionsFromEnvironment();
  if (!resolvedOptions) {
    throw noOptionsError();
  }

  const releaseOnDeref = serverSettings.releaseOnDeref;
  if (releaseOnDeref !== undefined && typeof FinalizationRegistry === 'undefined') {
    throw finalizationRegistryNotSupportedError();
  }

  const optionsSnapshot = cloneValue(resolvedOptions);
  const nameString = computeServerAppName(optionsSnapshot, serverSettings);
  const existing = serverAppRegistry.get(nameString);
  if (existing !== undefined) {
    existing.incRefCount(releaseOnDeref);
    return existing.app;
  }

  const { refusal, sandbox } = ensureBackendForOptions(optionsSnapshot);

  if (serverSettings.authIdToken) {
    validateServerTokenTTL(serverSettings.authIdToken, 'authIdToken');
  }
  if (serverSettings.appCheckToken) {
    validateServerTokenTTL(serverSettings.appCheckToken, 'appCheckToken');
  }

  const storedSettings: FirebaseServerAppSettings = {
    ...serverSettings,
    automaticDataCollectionEnabled: automaticDataCollection,
    releaseOnDeref: undefined,
  };
  if (rawServerConfig && typeof rawServerConfig === 'object' && 'releaseOnDeref' in rawServerConfig) {
    rawServerConfig.releaseOnDeref = undefined;
  } else if (
    optionsOrConfig &&
    typeof optionsOrConfig === 'object' &&
    isFirebaseServerAppSettingsObject(optionsOrConfig) &&
    'releaseOnDeref' in optionsOrConfig
  ) {
    optionsOrConfig.releaseOnDeref = undefined;
  }

  const app = createFirebaseServerApp(
    nameString,
    cloneValue(optionsSnapshot),
    automaticDataCollection,
    storedSettings,
  );

  if (typeof storedSettings.appCheckToken === 'string' && storedSettings.appCheckToken.length > 0) {
    recordServerAppCheckToken(app, storedSettings.appCheckToken);
  }

  if (refusal !== undefined) {
    attachRefusedSandboxApp(app, refusal, serverAppDeletedError);
  } else if (sandbox !== undefined) {
    let initialUser = null;
    if (typeof storedSettings.authIdToken === 'string' && storedSettings.authIdToken.length > 0) {
      initialUser = authStateFromServerIdToken(
        storedSettings.authIdToken,
        optionsSnapshot.projectId,
        sandbox,
      );
    }
    attachSandboxApp(app, sandbox, createAppSession(initialUser), serverAppDeletedError);
  }

  let refCount = 0;
  let finalizer: FinalizationRegistry<FirebaseServerApp> | null = null;
  if (typeof FinalizationRegistry !== 'undefined') {
    finalizer = new FinalizationRegistry((targetApp) => {
      if (deletedServerApps.has(targetApp)) return;
      void deleteApp(targetApp);
    });
  }

  const entry: ServerRegistryEntry = {
    app,
    incRefCount(derefTarget) {
      if (deletedServerApps.has(app)) return;
      refCount += 1;
      if (derefTarget !== undefined && finalizer !== null) {
        finalizer.register(derefTarget, app);
      }
    },
    decRefCount() {
      if (deletedServerApps.has(app)) return 0;
      refCount -= 1;
      return refCount;
    },
  };
  entry.incRefCount(releaseOnDeref);
  serverAppRegistry.set(nameString, entry);
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
  if (deletedServerApps.has(app)) throw serverAppDeletedError();
  if (deletedApps.has(app)) {
    const knownName = appNames.get(app) ?? app.name;
    throw appDeletedError(knownName);
  }
  const serverName = serverAppNames.get(app);
  if (serverName !== undefined) {
    const serverEntry = serverAppRegistry.get(serverName);
    if (serverEntry?.app === app) {
      if (serverEntry.decRefCount() > 0) return;
      serverAppRegistry.delete(serverName);
    }
    deletedServerApps.add(app);
    await markSandboxAppDeleted(app);
    return;
  }
  const name = appNames.get(app) ?? app.name;
  const entry = appRegistry.get(name);
  if (entry?.app === app) appRegistry.delete(name);
  deletedApps.add(app);
  await markSandboxAppDeleted(app);
}

/** Test-only module reset; deliberately absent from the public app barrel. */
export async function resetAppRegistryForTests(): Promise<void> {
  await Promise.all([
    ...[...appRegistry.values()].map(({ app }) => markSandboxAppDeleted(app)),
    ...[...serverAppRegistry.values()].map(({ app }) => {
      deletedServerApps.add(app);
      return markSandboxAppDeleted(app);
    }),
  ]);
  appRegistry.clear();
  serverAppRegistry.clear();
  if (ownsBackendSandbox) {
    backendSandbox?.dispose();
  }
  backendSandbox = undefined;
  ownsBackendSandbox = false;
  backendRefusal = undefined;
  backendOptions = undefined;
}

installDefaultAppResolver(getApp);
