/**
 * `pyric-admin/app` — Phase 3 initializeApp surface (ADR-001 D6) plus the
 * default-app registry and AMBIENT INIT (adoption experience, layer 3).
 *
 * Mirror shape: at cutover this becomes `pyric-admin/app` and is the
 * single entry point where the sandbox-vs-prod choice is made for the
 * admin surface. Every `pyric-admin/*` subpath inspects the handle's
 * brand for backend dispatch.
 *
 * Current shadow scope:
 *   - `initializeApp({ credential, ... })` — prod-backed (live;
 *     delegates to `firebase-admin/app.initializeApp`).
 *   - `initializeApp({ sandbox })` — sandbox-backed (live).
 *   - `initializeApp()` — BARE, zero pyric identifiers in app code. The
 *     environment decides the backend (see "Ambient init" below).
 *   - Per-subpath adapter dispatch via the brand: implemented in
 *     `pyric-admin/{auth,database,storage}` via structural
 *     checks on the `app` argument. Phase 4 commits use property
 *     probing today; cutover swaps to brand-symbol reads.
 *
 * ── Default-app registry ──────────────────────────────────────────────
 *
 * Mirrors `firebase-admin/app`'s lifecycle exactly (oracle:
 * `firebase-admin/lib/app/lifecycle.js`):
 *
 *   - `initializeApp(config?, name?)` registers under `'[DEFAULT]'` when
 *     unnamed; `getApp(name?)` / `getApps()` / `deleteApp(app)` read it.
 *   - Duplicate-name errors carry firebase-admin's codes and message
 *     text: `app/duplicate-app` for a config'd re-init with a different
 *     configuration, `app/invalid-app-options` for a bare-vs-config'd
 *     mismatch (firebase-admin's autoInit mismatch), `app/no-app` from
 *     `getApp` on a missing name, `app/invalid-app-name` for a
 *     non-string/empty name. Errors reuse firebase-admin's own
 *     `FirebaseAppError` class, so `instanceof`, `constructor.name`,
 *     `.code`, and message text match production byte-for-byte
 *     (oracle: `admin-app-*` observations).
 *   - Idempotency mirror: a bare `initializeApp()` repeated for the same
 *     name returns the existing auto-initialized app (firebase-admin's
 *     autoInit path); `initializeApp({ sandbox })` repeated with the
 *     SAME `Sandbox` reference returns the existing app (the reference
 *     is our deep-equal analog — sandboxes have identity, not value
 *     equality); prod re-inits delegate the equality decision to
 *     firebase-admin itself (deep-equal options → same app; credential /
 *     httpAgent present → `app/invalid-app-options`, exactly upstream).
 *
 * ── Ambient init (bare `initializeApp()`) ─────────────────────────────
 *
 * The user's server code contains ZERO pyric identifiers — bare
 * `initializeApp()` + no-arg `getDatabase()` / `getAuth()`. The
 * environment picks the backend:
 *
 *   - `PYRIC_SANDBOX` unset → exactly firebase-admin's behavior:
 *     delegate to `firebase-admin/app.initializeApp()` (FIREBASE_CONFIG
 *     env + application-default credentials), register the prod arm.
 *   - `PYRIC_SANDBOX=remote` or `remote:<url>` → obtain a remote sandbox
 *     handle from the factory installed by `pyric-tools/register` at
 *     `globalThis[REMOTE_SANDBOX_FACTORY]`
 *     (`Symbol.for('pyric.remote.sandboxFactory')`) and register the
 *     sandbox arm. One activation line is logged to stderr. If the env
 *     is set but no factory is installed, throw with remediation (run
 *     under `pyric dev`, or add `--import pyric-tools/register` to
 *     NODE_OPTIONS).
 *   - Production guard: refuses to route to a sandbox when
 *     `NODE_ENV === 'production'`, unless `PYRIC_SANDBOX_FORCE=1`.
 *
 * Ambient resolution happens ONLY on the bare call — any explicit
 * config (`{ sandbox }` or prod `AppOptions`, even `{}`) bypasses the
 * env entirely, so pyric-aware code keeps full control.
 */

import {
  REMOTE_SANDBOX_FACTORY,
  type RemoteSandboxFactory,
  type RemoteSandboxFactoryOptions,
  type Sandbox,
} from 'pyric/sandbox';
import {
  initializeApp as initializeFirebaseAdminApp,
  deleteApp as deleteFirebaseAdminApp,
  FirebaseAppError,
  type App as AdminApp,
  type AppOptions,
} from 'firebase-admin/app';

/**
 * Brand on every PyricAdminApp. Matches the symbol used in
 * `pyric/app` so a future shared `pyric/runtime` package can
 * unify dispatch helpers across both packages.
 */
export const ADMIN_APP_TARGET = Symbol.for('pyric.admin.app.target');

export type PyricAdminAppTarget = 'sandbox' | 'prod';

/** firebase-admin's default app name — `'[DEFAULT]'`. */
export const DEFAULT_APP_NAME = '[DEFAULT]';

export interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  /** Registry name (mirrors firebase-admin `App.name`). */
  readonly name: string;
}

export interface ProdAdminApp {
  readonly [ADMIN_APP_TARGET]: 'prod';
  readonly adminApp: AdminApp;
  /** Registry name (mirrors firebase-admin `App.name`). */
  readonly name: string;
}

export type PyricAdminApp = SandboxAdminApp | ProdAdminApp;

export type InitializeAdminAppConfig = { sandbox: Sandbox } | AppOptions;

/**
 * App-lifecycle errors reuse `firebase-admin`'s own exported
 * `FirebaseAppError` so the thrown error's class, `constructor.name`,
 * `.code` (`app/no-app`, `app/duplicate-app`, `app/invalid-app-options`,
 * `app/invalid-app-name`, `app/invalid-argument`), and message text match
 * production byte-for-byte (oracle: `admin-app-*` observations assert
 * `errorName: "FirebaseAppError"`). The published typings declare only the
 * base `Error` constructor, but the real runtime class is
 * `new FirebaseAppError(code, message)` where `code` becomes `app/<code>` —
 * the typed cast recovers it.
 */
const AdminAppError = FirebaseAppError as unknown as new (
  code: string,
  message: string,
) => Error & { readonly code: string };

/** @deprecated Alias kept for pre-merge call sites; errors ARE `FirebaseAppError`. */
export const PyricAdminAppError = AdminAppError;
export type PyricAdminAppError = InstanceType<typeof AdminAppError>;

// ─── Registry ───────────────────────────────────────────────────────────
//
// Module-level, matching firebase-admin's `defaultAppStore` (one store per
// module instance). `autoInitApps` tracks which registered apps came from a
// BARE `initializeApp()` — firebase-admin's `autoInit` flag — so the
// bare-vs-config'd mismatch throws exactly like upstream.

const appRegistry = new Map<string, PyricAdminApp>();
const autoInitApps = new WeakSet<PyricAdminApp>();

/** firebase-admin's app-name validation, verbatim message. */
function validateAppName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '') {
    throw new AdminAppError(
      'invalid-app-name',
      `Invalid Firebase app name "${String(name)}" provided. App name must be a non-empty string.`,
    );
  }
}

/** firebase-admin's message for every same-name/different-config case. */
function alreadyExists(name: string, code: 'duplicate-app' | 'invalid-app-options'): Error & { readonly code: string } {
  return new AdminAppError(
    code,
    `A Firebase app named "${name}" already exists with a different configuration.`,
  );
}

/**
 * Initialize a Pyric admin app and register it under `name`
 * (default `'[DEFAULT]'`), mirroring `firebase-admin/app.initializeApp`.
 *
 * @example
 * ```ts
 * // Ambient (zero pyric identifiers — environment decides)
 * import { initializeApp } from 'pyric-admin/app';
 * const app = initializeApp();
 *
 * // Prod-backed
 * import { applicationDefault } from 'firebase-admin/app';
 * const app = initializeApp({ credential: applicationDefault() });
 *
 * // Sandbox-backed
 * import { initializeSandbox } from 'pyric/sandbox';
 * const app = initializeApp({ sandbox: initializeSandbox() });
 * ```
 */
export function initializeApp(
  config?: InitializeAdminAppConfig,
  name: string = DEFAULT_APP_NAME,
): PyricAdminApp {
  validateAppName(name);
  const existing = appRegistry.get(name);

  // ── Bare call: ambient resolution ────────────────────────────────────
  if (config === undefined) {
    if (existing !== undefined) {
      // firebase-admin: two autoInit calls return the same app; an
      // autoInit call against a config'd app is an options mismatch.
      if (autoInitApps.has(existing)) return existing;
      throw alreadyExists(name, 'invalid-app-options');
    }
    const app = initializeAmbientApp(name);
    appRegistry.set(name, app);
    autoInitApps.add(app);
    return app;
  }

  // ── Explicit sandbox config ──────────────────────────────────────────
  if (isSandboxConfig(config)) {
    if (existing !== undefined) {
      // Reference identity is the deep-equal analog for sandboxes.
      if (
        !autoInitApps.has(existing) &&
        existing[ADMIN_APP_TARGET] === 'sandbox' &&
        existing.sandbox === config.sandbox
      ) {
        return existing;
      }
      throw alreadyExists(
        name,
        autoInitApps.has(existing) ? 'invalid-app-options' : 'duplicate-app',
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

  // ── Explicit prod options ────────────────────────────────────────────
  if (existing !== undefined) {
    if (existing[ADMIN_APP_TARGET] === 'prod' && !autoInitApps.has(existing)) {
      // Delegate the equality decision to firebase-admin itself: deep-
      // equal options return the same AdminApp; credential / httpAgent
      // re-inits throw app/invalid-app-options; different options throw
      // app/duplicate-app — all with upstream's exact messages.
      const adminApp = initializeFirebaseAdminApp(config, name);
      if (adminApp === existing.adminApp) return existing;
    }
    throw alreadyExists(
      name,
      autoInitApps.has(existing) ? 'invalid-app-options' : 'duplicate-app',
    );
  }
  const adminApp = initializeFirebaseAdminApp(config, name);
  const app: ProdAdminApp = { [ADMIN_APP_TARGET]: 'prod', adminApp, name };
  appRegistry.set(name, app);
  return app;
}

/**
 * Return the registered app for `name` (default `'[DEFAULT]'`).
 * Mirrors `firebase-admin/app.getApp` — including the exact `app/no-app`
 * error text on a miss.
 */
export function getApp(name: string = DEFAULT_APP_NAME): PyricAdminApp {
  validateAppName(name);
  const app = appRegistry.get(name);
  if (app === undefined) {
    const lead =
      name === DEFAULT_APP_NAME
        ? 'The default Firebase app does not exist. '
        : `Firebase app named "${name}" does not exist. `;
    throw new AdminAppError(
      'no-app',
      lead + 'Make sure you call initializeApp() before using any of the Firebase services.',
    );
  }
  return app;
}

/**
 * A copy of the list of all registered apps.
 * Mirrors `firebase-admin/app.getApps`.
 */
export function getApps(): PyricAdminApp[] {
  return Array.from(appRegistry.values());
}

/**
 * Remove `app` from the registry, mirroring `firebase-admin/app.deleteApp`.
 * Prod-backed apps also delete the underlying firebase-admin app (freeing
 * its resources and its slot in firebase-admin's own registry, so the
 * name can be re-initialized). Sandbox-backed apps only deregister — the
 * `Sandbox` handle's lifetime belongs to its creator.
 */
export function deleteApp(app: PyricAdminApp): Promise<void> {
  if (typeof app !== 'object' || app === null || !(ADMIN_APP_TARGET in app)) {
    throw new AdminAppError('invalid-argument', 'Invalid app argument.');
  }
  // Make sure the given app is actually registered (throws app/no-app).
  const existing = getApp(app.name);
  appRegistry.delete(existing.name);
  if (existing[ADMIN_APP_TARGET] === 'prod') {
    return deleteFirebaseAdminApp(existing.adminApp);
  }
  return Promise.resolve();
}

// ─── Ambient init ───────────────────────────────────────────────────────

/**
 * Resolve a bare `initializeApp()` from the environment. See the
 * module-level "Ambient init" docs for the full contract.
 */
function initializeAmbientApp(name: string): PyricAdminApp {
  const env = process.env.PYRIC_SANDBOX;
  if (env === undefined || env.trim() === '') {
    // Unset → exactly today's prod behavior: firebase-admin's autoInit
    // (FIREBASE_CONFIG env options + application-default credentials).
    const adminApp = initializeFirebaseAdminApp(undefined, name);
    return { [ADMIN_APP_TARGET]: 'prod', adminApp, name };
  }

  const opts = parsePyricSandboxEnv(env);

  if (
    process.env.NODE_ENV === 'production' &&
    process.env.PYRIC_SANDBOX_FORCE !== '1'
  ) {
    throw new Error(
      'pyric-admin: PYRIC_SANDBOX is set but NODE_ENV is "production" — ' +
        'refusing to route firebase-admin to a development sandbox. ' +
        'Unset PYRIC_SANDBOX in production, or set PYRIC_SANDBOX_FORCE=1 ' +
        'if this routing is intentional.',
    );
  }

  const factory = (
    globalThis as { [REMOTE_SANDBOX_FACTORY]?: RemoteSandboxFactory }
  )[REMOTE_SANDBOX_FACTORY];
  if (typeof factory !== 'function') {
    throw new Error(
      `pyric-admin: PYRIC_SANDBOX=${env} is set but no remote sandbox ` +
        'factory is installed (globalThis[Symbol.for(' +
        "'pyric.remote.sandboxFactory')] is absent). Run your server " +
        'under `pyric dev`, or add `--import pyric-tools/register` to ' +
        'NODE_OPTIONS.',
    );
  }

  const sandbox = factory(opts);
  process.stderr.write(
    `pyric: firebase-admin routed to sandbox${opts.url !== undefined ? ` at ${opts.url}` : ''}\n`,
  );
  return { [ADMIN_APP_TARGET]: 'sandbox', sandbox, name };
}

/**
 * Parse the `PYRIC_SANDBOX` activator value.
 *
 *   - `remote`        → `{}` (factory discovers the running `pyric dev`)
 *   - `remote:<url>`  → `{ url }` (everything after the FIRST colon —
 *     URLs contain colons, so only the mode prefix is split off)
 *
 * Anything else throws: an unrecognized activator must never silently
 * fall through to prod (mode-by-side-effect in the failure direction).
 */
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
      'values: "remote" (auto-discover the running `pyric dev`) or ' +
      '"remote:<url>".',
  );
}

// ─── Guards ─────────────────────────────────────────────────────────────

function isSandboxConfig(
  config: InitializeAdminAppConfig,
): config is { sandbox: Sandbox } {
  return typeof config === 'object' && config !== null && 'sandbox' in config;
}

export function isSandboxAdminApp(app: PyricAdminApp): app is SandboxAdminApp {
  return app[ADMIN_APP_TARGET] === 'sandbox';
}

export function isProdAdminApp(app: PyricAdminApp): app is ProdAdminApp {
  return app[ADMIN_APP_TARGET] === 'prod';
}
