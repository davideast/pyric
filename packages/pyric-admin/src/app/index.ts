/**
 * `pyric-admin/app` — sandbox-only admin app registry.
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
import { assertAdminAppActive, markAdminAppDeleted } from './lifecycle.js';

/** Brand carried by every sandbox admin app. */
export const ADMIN_APP_TARGET = Symbol.for('pyric.admin.app.target');
export type PyricAdminAppTarget = 'sandbox';

/** firebase-admin's default app name. */
export const DEFAULT_APP_NAME = '[DEFAULT]';

export interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  readonly name: string;
}

export type PyricAdminApp = SandboxAdminApp;
export type InitializeAdminAppConfig = { sandbox: Sandbox };

/**
 * Firebase Functions' ESM runtime statically imports this credential factory
 * while linking its database provider. Pyric initializes the sandbox app
 * before that provider executes, so the factory is not used by supported
 * Functions flows. Keep the named export link-compatible, but fail clearly if
 * application code asks the development sandbox for production credentials.
 */
export function applicationDefault(): never {
  throw new Error(
    'pyric-admin/app: applicationDefault() is unavailable in the sandbox. ' +
      'Pyric development does not use production credentials.',
  );
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
interface GlobalAppRegistry {
  [APP_REGISTRY]?: Map<string, PyricAdminApp>;
  [AMBIENT_APPS]?: WeakSet<PyricAdminApp>;
}
const globalRegistry = globalThis as GlobalAppRegistry;
const appRegistry = globalRegistry[APP_REGISTRY] ??= new Map<string, PyricAdminApp>();
const ambientApps = globalRegistry[AMBIENT_APPS] ??= new WeakSet<PyricAdminApp>();

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
  config?: InitializeAdminAppConfig,
  name: string = DEFAULT_APP_NAME,
): PyricAdminApp {
  validateAppName(name);
  const existing = appRegistry.get(name);

  if (config === undefined) {
    if (existing !== undefined) {
      if (ambientApps.has(existing)) return existing;
      throw alreadyExists(name, 'invalid-app-options');
    }
    const app = initializeAmbientApp(name);
    appRegistry.set(name, app);
    ambientApps.add(app);
    return app;
  }

  if (!isSandboxConfig(config)) {
    throw new TypeError(
      'pyric-admin/app is a sandbox-only mirror. Production applications must ' +
        'load firebase-admin/app without Pyric activation.',
    );
  }

  if (existing !== undefined) {
    if (!ambientApps.has(existing) && existing.sandbox === config.sandbox) return existing;
    throw alreadyExists(
      name,
      ambientApps.has(existing) ? 'invalid-app-options' : 'duplicate-app',
    );
  }

  const app: SandboxAdminApp = {
    [ADMIN_APP_TARGET]: 'sandbox',
    sandbox: config.sandbox,
    name,
  };
  appRegistry.set(name, app);
  return app;
}

/** Return the registered app for `name`. */
export function getApp(name: string = DEFAULT_APP_NAME): PyricAdminApp {
  validateAppName(name);
  const app = appRegistry.get(name);
  if (app === undefined) {
    const lead = name === DEFAULT_APP_NAME
      ? 'The default Firebase app does not exist. '
      : `Firebase app named "${name}" does not exist. `;
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
  markAdminAppDeleted(existing);
  return Promise.resolve();
}

function initializeAmbientApp(name: string): PyricAdminApp {
  const env = process.env.PYRIC_SANDBOX;
  if (env === undefined || env.trim() === '') {
    throw new Error(
      'pyric-admin/app is a sandbox-only mirror and no sandbox is active. ' +
        'Run under `pyric dev`, set PYRIC_SANDBOX with @pyric/cli/register, ' +
        'or load firebase-admin/app without Pyric activation for production.',
    );
  }

  const opts = parsePyricSandboxEnv(env);
  if (process.env.NODE_ENV === 'production' && process.env.PYRIC_SANDBOX_FORCE !== '1') {
    throw new Error(
      'pyric-admin: PYRIC_SANDBOX is set but NODE_ENV is "production" — ' +
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
        'Run your server under `pyric dev`, or add `--import @pyric/cli/register` to NODE_OPTIONS.',
    );
  }

  const sandbox = factory(opts);
  process.stderr.write(
    `pyric: firebase-admin routed to sandbox${opts.url !== undefined ? ` at ${opts.url}` : ''}\n`,
  );
  return { [ADMIN_APP_TARGET]: 'sandbox', sandbox, name };
}

function parsePyricSandboxEnv(env: string): RemoteSandboxFactoryOptions {
  const value = env.trim();
  if (value === 'remote') return {};
  if (value.startsWith('remote:')) {
    const url = value.slice('remote:'.length).trim();
    if (url === '') {
      throw new Error(
        'pyric-admin: PYRIC_SANDBOX=remote: has an empty url. Use ' +
          'PYRIC_SANDBOX=remote to auto-discover the running `pyric dev`, ' +
          'or PYRIC_SANDBOX=remote:<url> with the host url.',
      );
    }
    return { url };
  }
  throw new Error(
    `pyric-admin: unrecognized PYRIC_SANDBOX value "${env}". Supported ` +
      'values: "remote" (auto-discover the running `pyric dev`) or "remote:<url>".',
  );
}

function isSandboxConfig(config: InitializeAdminAppConfig): config is { sandbox: Sandbox } {
  return typeof config === 'object' && config !== null && 'sandbox' in config;
}

export function isSandboxAdminApp(app: PyricAdminApp): app is SandboxAdminApp {
  return app[ADMIN_APP_TARGET] === 'sandbox';
}
