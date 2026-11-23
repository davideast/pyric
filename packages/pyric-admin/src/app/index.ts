/**
 * `pyric-admin/app` -- sandbox-only admin app registry.
 *
 * Production selection happens before this module loads: activated Node
 * processes resolve `firebase-admin/app` here, while inactive applications
 * continue resolving their own `firebase-admin/app` package unchanged.
 */
import {
  REMOTE_SANDBOX_FACTORY,
  type RemoteSandboxFactory,
  type RemoteSandboxFactoryOptions,
  type Sandbox,
} from 'pyric/sandbox';
import { parsePyricSandbox, processActivation } from 'pyric/sandbox/internal';
import { readFileSync } from 'node:fs';

import {
  IMPLICIT_DEFAULT_APPS,
  assertAdminAppActive,
  markAdminAppDeleted,
} from './lifecycle.js';
import { keepAppCredentialProjectId, keepCredentialProjectId } from './project-id.js';

/** Brand carried by every sandbox admin app. */
export const ADMIN_APP_TARGET = Symbol.for('pyric.admin.app.target');
export type PyricAdminAppTarget = 'sandbox';

/** firebase-admin's default app name. */
export const DEFAULT_APP_NAME = '[DEFAULT]';

export interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  readonly name: string;
  /** The options the app was initialized with, as firebase-admin's `App.options` keeps them. */
  readonly options: AdminAppOptions;
}

/** The app options kept on `app.options`, matching firebase-admin's `AppOptions` (`credential` is preserved or synthesized via `applicationDefault()`, `databaseURL` selects the RTDB instance, `projectId` names its default instance, `storageBucket` names its default Storage bucket, and `databaseAuthVariableOverride` downscopes RTDB access to the rules). */
export interface AdminAppOptions {
  readonly credential?: object;
  /** As firebase-admin keeps it: `null` acts as an unauthenticated client, an object as that `auth`; left out, the app has admin access. */
  readonly databaseAuthVariableOverride?: object | null;
  readonly databaseURL?: string;
  readonly serviceAccountId?: string;
  readonly storageBucket?: string;
  readonly projectId?: string;
  readonly httpAgent?: unknown;
}

export type PyricAdminApp = SandboxAdminApp;
export type InitializeAdminAppConfig = { sandbox: Sandbox } & AdminAppOptions;

const CREDENTIAL_BRAND = Symbol.for('pyric.admin.credential');

/**
 * Link-compatible mirror of `firebase-admin/app`'s `applicationDefault(httpAgent?)`.
 * Returns an inert sandbox credential token so unchanged application setup code
 * and `firebase-functions`'s lazy runtime app initialization can pass
 * `credential: applicationDefault()` under `@pyric/cli/register` without
 * reading host production credentials.
 */
export function applicationDefault(_httpAgent?: unknown): object {
  return { [CREDENTIAL_BRAND]: 'applicationDefault' };
}

/**
 * Link-compatible mirror of `firebase-admin/app`'s `cert(serviceAccountPathOrObject)`.
 * Returns an inert sandbox credential token so unchanged application setup code
 * can assign `appOptions.credential = cert(...)` under `@pyric/cli/register`.
 *
 * It keeps one field, the service account's project id, because firebase-admin
 * finds an app's project there when the options name none. A path is read as a
 * JSON file; a file that is missing, unreadable, or has no project id gives a
 * credential without one, and never throws, so apps run without a key on disk.
 */
export function cert(serviceAccountPathOrObject: unknown): object {
  const credential = { [CREDENTIAL_BRAND]: 'cert' };
  keepCredentialProjectId(credential, serviceAccountPathOrObject);
  return credential;
}

/**
 * Link-compatible mirror of `firebase-admin/app`'s `refreshToken(refreshTokenPathOrObject)`.
 * Returns an inert sandbox credential token, as {@link cert} does. Nothing
 * in Pyric reads a refresh token, so the argument isn't kept.
 */
export function refreshToken(_refreshTokenPathOrObject: unknown): object {
  return { [CREDENTIAL_BRAND]: 'refreshToken' };
}

/** Local error with the observable firebase-admin app-error shape. */
class FirebaseAppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FirebaseAppError';
    this.code = `app/${code}`;
  }
}

// Node may evaluate this ESM-only mirror through distinct require(esm) and
// import module records when the register hook rewrites both CJS and ESM
// Firebase consumers. Firebase Admin's app registry is process-wide, so keep
// the mirror registry behind Symbol.for as well: both module records must see
// the same default app and sandbox handle.
const APP_REGISTRY = Symbol.for('pyric.admin.app.registry');
const AMBIENT_APPS = Symbol.for('pyric.admin.app.ambientApps');
const APP_STORED_OPTIONS = Symbol.for('pyric.admin.app.storedOptions');
interface GlobalAppRegistry {
  [APP_REGISTRY]?: Map<string, PyricAdminApp>;
  [AMBIENT_APPS]?: WeakSet<PyricAdminApp>;
  [IMPLICIT_DEFAULT_APPS]?: WeakSet<PyricAdminApp>;
  [APP_STORED_OPTIONS]?: WeakMap<SandboxAdminApp, AdminAppOptions>;
}
const globalRegistry = globalThis as GlobalAppRegistry;
const appRegistry = globalRegistry[APP_REGISTRY] ??= new Map<string, PyricAdminApp>();
const ambientApps = globalRegistry[AMBIENT_APPS] ??= new WeakSet<PyricAdminApp>();
const implicitDefaultApps = globalRegistry[IMPLICIT_DEFAULT_APPS] ??= new WeakSet<PyricAdminApp>();
const storedAppOptions = globalRegistry[APP_STORED_OPTIONS] ??= new WeakMap<SandboxAdminApp, AdminAppOptions>();

function cloneValueForOptions(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (CREDENTIAL_BRAND in value) {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValueForOptions(item));
  }
  if (value.constructor !== Object) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const propValue = (value as Record<string, unknown>)[key];
    if (propValue !== undefined) {
      copy[key] = cloneValueForOptions(propValue);
    }
  }
  return copy;
}

function createSandboxAdminApp(
  name: string,
  sandbox: Sandbox,
  initialOptions: AdminAppOptions,
): SandboxAdminApp {
  const app: SandboxAdminApp = {
    [ADMIN_APP_TARGET]: 'sandbox',
    sandbox,
    name,
    get options(): AdminAppOptions {
      assertAdminAppActive(app);
      const current = storedAppOptions.get(app);
      if (current === undefined) {
        return {};
      }
      return cloneValueForOptions(current) as AdminAppOptions;
    },
  };
  storedAppOptions.set(app, cloneValueForOptions(initialOptions) as AdminAppOptions);
  return app;
}

function validateAppName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '') {
    throw new FirebaseAppError(
      'invalid-app-name',
      `Invalid Firebase app name "${String(name)}" provided. App name must be a non-empty string.`,
    );
  }
}

function alreadyExists(name: string, code: 'duplicate-app' | 'invalid-app-options'): FirebaseAppError {
  return new FirebaseAppError(
    code,
    `A Firebase app named "${name}" already exists with a different configuration.`,
  );
}

/**
 * Initialize a sandbox admin app.
 *
 * An explicit `{ sandbox }` config binds an in-process or remote sandbox.
 * A bare call resolves the remote sandbox factory installed by
 * `@pyric/cli/register`. Production callers must import `firebase-admin/app`
 * without Pyric activation instead of passing production options here.
 */
export function initializeApp(
  config?: InitializeAdminAppConfig | Record<string, unknown>,
  name: string = DEFAULT_APP_NAME,
): PyricAdminApp {
  validateAppName(name);
  const existing = appRegistry.get(name);

  const isBareOrAmbientConfig = config === undefined || !isSandboxConfig(config);
  if (isBareOrAmbientConfig) {
    if (existing !== undefined) {
      const isExistingAmbient = ambientApps.has(existing);
      if (isExistingAmbient) {
        if (implicitDefaultApps.has(existing)) {
          implicitDefaultApps.delete(existing);
          if (config !== undefined) {
            const upgradedOptions = ambientAppOptions(config, name);
            storedAppOptions.set(existing, cloneValueForOptions(upgradedOptions) as AdminAppOptions);
            keepAppCredentialProjectId(existing, config);
          }
        }
        return existing;
      }
      throw alreadyExists(name, 'invalid-app-options');
    }
    const app = initializeAmbientApp(name, ambientAppOptions(config, name));
    keepAppCredentialProjectId(app, config);
    appRegistry.set(name, app);
    ambientApps.add(app);
    return app;
  }

  if (existing !== undefined) {
    if (!ambientApps.has(existing) && existing.sandbox === config.sandbox) return existing;
    let errorCode: 'duplicate-app' | 'invalid-app-options' = 'duplicate-app';
    if (ambientApps.has(existing)) errorCode = 'invalid-app-options';
    throw alreadyExists(name, errorCode);
  }

  const app = createSandboxAdminApp(name, config.sandbox, appOptionsFrom(config, name));
  keepAppCredentialProjectId(app, config);
  appRegistry.set(name, app);
  return app;
}

/** Return the registered app for `name`. */
export function getApp(name: string = DEFAULT_APP_NAME): PyricAdminApp {
  validateAppName(name);
  const app = appRegistry.get(name);
  if (app === undefined) {
    let lead = `Firebase app named "${name}" does not exist. `;
    if (name === DEFAULT_APP_NAME) {
      lead = 'The default Firebase app does not exist. ';
    }
    throw new FirebaseAppError(
      'no-app',
      lead + 'Make sure you call initializeApp() before using any of the Firebase services.',
    );
  }
  return app;
}

/** Return a copy of the app registry. */
export function getApps(): PyricAdminApp[] {
  return Array.from(appRegistry.values());
}

/** Remove a sandbox app from the registry. */
export function deleteApp(app: PyricAdminApp): Promise<void> {
  if (typeof app !== 'object' || app === null || !(ADMIN_APP_TARGET in app)) {
    throw new FirebaseAppError('invalid-argument', 'Invalid app argument.');
  }
  assertAdminAppActive(app);
  const existing = getApp(app.name);
  appRegistry.delete(existing.name);
  return markAdminAppDeleted(existing);
}

function initializeAmbientApp(name: string, options: AdminAppOptions): PyricAdminApp {
  const env = process.env.PYRIC_SANDBOX;
  const isEnvUnset = env === undefined || env.trim() === '';
  // A host running in this process (the Vite plugin's dev server) activates
  // it without the variable; see `installProcessActivation`.
  let activation = undefined;
  if (isEnvUnset) {
    activation = processActivation();
  }
  if (activation !== undefined) {
    process.stderr.write(`pyric: firebase-admin routed to sandbox (${activation.label})\n`);
    return createSandboxAdminApp(name, activation.adminSandbox(), options);
  }
  if (env === undefined || isEnvUnset) {
    throw new Error(
      'pyric-admin/app is a sandbox-only mirror and no sandbox is active. ' +
        'Run under `pyric sandbox`, set PYRIC_SANDBOX with @pyric/cli/register, ' +
        'or load firebase-admin/app without Pyric activation for production.',
    );
  }

  const opts = parsePyricSandboxEnv(env);
  if (process.env.NODE_ENV === 'production' && process.env.PYRIC_SANDBOX_FORCE !== '1') {
    throw new Error(
      'pyric-admin: PYRIC_SANDBOX is set but NODE_ENV is "production" -- ' +
        'refusing to route firebase-admin to a development sandbox. ' +
        'Unset PYRIC_SANDBOX in production, or set PYRIC_SANDBOX_FORCE=1 ' +
        'if this routing is intentional.',
    );
  }

  const factory = (globalThis as { [REMOTE_SANDBOX_FACTORY]?: RemoteSandboxFactory })[
    REMOTE_SANDBOX_FACTORY
  ];
  if (typeof factory !== 'function') {
    throw new Error(
      `pyric-admin: PYRIC_SANDBOX=${env} is set but no remote sandbox ` +
        "factory is installed (globalThis[Symbol.for('pyric.remote.sandboxFactory')] is absent). " +
        'Run your server under `pyric sandbox`, or add `--import @pyric/cli/register` to NODE_OPTIONS.',
    );
  }

  const sandbox = factory(opts);
  let urlSuffix = '';
  if (opts.url !== undefined) {
    urlSuffix = ` at ${opts.url}`;
  }
  process.stderr.write(`pyric: firebase-admin routed to sandbox${urlSuffix}\n`);
  return createSandboxAdminApp(name, sandbox, options);
}

function parsePyricSandboxEnv(env: string): RemoteSandboxFactoryOptions {
  const activation = parsePyricSandbox(env);
  if (activation.mode === 'remote') {
    if (activation.url !== undefined) {
      return { url: activation.url };
    }
    return {};
  }
  const isEmptyUrl = activation.mode === 'invalid' && activation.reason === 'empty-url';
  if (isEmptyUrl) {
    throw new Error(
      'pyric-admin: PYRIC_SANDBOX=remote: has an empty url. Use ' +
        'PYRIC_SANDBOX=remote to auto-discover the running `pyric sandbox`, ' +
        'or, from outside the project directory, PYRIC_SANDBOX=remote:<url> with the host url.',
    );
  }
  throw new Error(
    `pyric-admin: unrecognized PYRIC_SANDBOX value "${env}". Supported ` +
      'values: "1", "true", "remote" (auto-discover the running `pyric sandbox`), or "remote:<url>".',
  );
}

function isSandboxConfig(config: unknown): config is { sandbox: Sandbox } {
  return typeof config === 'object' && config !== null && !Array.isArray(config) && 'sandbox' in config;
}

export function isSandboxAdminApp(app: PyricAdminApp): app is SandboxAdminApp {
  return app[ADMIN_APP_TARGET] === 'sandbox';
}

function isNonNullOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidAdminCredential(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (CREDENTIAL_BRAND in value) {
    return true;
  }
  const getAccessToken = (value as { getAccessToken?: unknown }).getAccessToken;
  return typeof getAccessToken === 'function';
}

function resolveCredentialOption(config: Record<string, unknown>, name: string): object {
  if (!('credential' in config)) {
    return applicationDefault(config.httpAgent);
  }
  const candidate = config.credential;
  if (!isValidAdminCredential(candidate)) {
    throw new FirebaseAppError(
      'invalid-app-options',
      'Invalid Firebase app options passed as the first argument to initializeApp() for the ' +
        `app named "${name}". The "credential" property must be an object which implements ` +
        'the Credential interface.',
    );
  }
  return candidate;
}

/** Assembles `AdminAppOptions` explicitly, keeping `credential` as firebase-admin's `FirebaseApp` does. */
function appOptionsFrom(config: unknown, name: string): AdminAppOptions {
  if (config === undefined) {
    return { credential: applicationDefault() };
  }
  if (!isNonNullOptionsObject(config)) {
    throw new FirebaseAppError(
      'invalid-app-options',
      'Invalid Firebase app options passed as the first argument to initializeApp() for the ' +
        `app named "${name}". Options must be a non-null object.`,
    );
  }
  const credential = resolveCredentialOption(config, name);
  const assembled: {
    credential: object;
    databaseAuthVariableOverride?: object | null;
    databaseURL?: string;
    serviceAccountId?: string;
    storageBucket?: string;
    projectId?: string;
    httpAgent?: unknown;
  } = { credential };

  if (typeof config.databaseURL === 'string') {
    assembled.databaseURL = config.databaseURL;
  }
  if (typeof config.storageBucket === 'string' && config.storageBucket !== '') {
    assembled.storageBucket = config.storageBucket;
  }
  if (typeof config.projectId === 'string') {
    assembled.projectId = config.projectId;
  }
  if (typeof config.serviceAccountId === 'string') {
    assembled.serviceAccountId = config.serviceAccountId;
  }
  if (config.httpAgent !== undefined) {
    assembled.httpAgent = config.httpAgent;
  }
  // Kept as given, as firebase-admin keeps it; the database validates it on first use.
  if (config.databaseAuthVariableOverride !== undefined) {
    assembled.databaseAuthVariableOverride = config.databaseAuthVariableOverride as object | null;
  }
  return assembled;
}

/**
 * The options of a bare or ambient `initializeApp(options?)`. As firebase-admin
 * does, a call without options reads `FIREBASE_CONFIG`: a JSON object, or the
 * path of a file that holds one. The Functions runtime sets it.
 */
function ambientAppOptions(config: unknown, name: string): AdminAppOptions {
  if (config !== undefined) {
    return appOptionsFrom(config, name);
  }
  const raw = process.env.FIREBASE_CONFIG;
  if (raw === undefined || raw.trim() === '') {
    return { credential: applicationDefault() };
  }
  let text = raw;
  if (!raw.trim().startsWith('{')) {
    text = readFileSync(raw, 'utf8');
  }
  const parsed: unknown = JSON.parse(text);
  if (isNonNullOptionsObject(parsed)) {
    return appOptionsFrom(parsed, name);
  }
  return { credential: applicationDefault() };
}
