/**
 * `pyric/app` — Phase 3 initializeApp surface (ADR-001 D5) plus the client
 * default-app registry.
 *
 * Mirror shape: at cutover this becomes `pyric/app` and is the single entry
 * point where the sandbox-vs-prod choice is made. Every other subpath
 * (`getFirestore(app)`, `getAuth(app)`, `getDatabase(app)`, `getStorage(app)`)
 * is backend-agnostic — they inspect the `PyricApp` handle for the brand and
 * route accordingly.
 *
 * ── Default-app registry ──────────────────────────────────────────────────
 *
 * Mirrors `firebase/app`'s client app registry (oracle: the `app-registry-*`
 * observations captured from the installed `firebase/app` package):
 *
 *   - `initializeApp(config, name?)` registers under `'[DEFAULT]'` when unnamed;
 *     `getApp(name?)` / `getApps()` / `deleteApp(app)` read it.
 *   - Duplicate-name errors carry firebase/app's client codes and message text:
 *     `app/duplicate-app` for a same-name re-init with a DIFFERENT config,
 *     `app/no-app` from `getApp` on a missing name, `app/app-deleted` from
 *     `deleteApp` on an already-deleted app. Errors ARE firebase/app's own
 *     exported `FirebaseError` class (re-exported below), so `instanceof`,
 *     `constructor.name`, `.code`, and message text match production
 *     byte-for-byte (oracle: `app-registry-*` observations).
 *   - Idempotency mirror: a same-name re-init with EQUAL config returns the
 *     existing app (firebase's deep-equal-options path). Reference identity is
 *     our deep-equal analog for a `{ sandbox }` config (a Sandbox has identity,
 *     not value equality); prod `FirebaseOptions` are compared structurally.
 *
 * Two apps that must coexist need DISTINCT names — this is firebase's rule, not
 * a pyric quirk: `initializeApp(a); initializeApp(b)` (both default) throws
 * `app/duplicate-app`, exactly as `firebase/app` does. Independent app handles
 * pass a unique second-arg name.
 *
 * ── Deferred ──────────────────────────────────────────────────────────────
 *
 * `initializeServerApp` is NOT implemented: it is SSR (server-app) semantics
 * whose sandbox mirror pattern is undecided. It is recorded as deferred surface
 * debt in the compat census deny-list (packages/conformance/src/surface-denylist.ts,
 * tier `deferred`) and as an `unsupported` registry row, not silently dropped.
 *
 * Current shadow scope for adapter dispatch (unchanged): the `getXxx(app)`
 * wrappers still re-export from `pyric/firestore` / `pyric/auth` / etc. Folding
 * the unified handle over the existing per-backend factories lands at cutover.
 */

import type { Sandbox } from 'pyric/sandbox';
import {
  initializeApp as initializeFirebaseApp,
  deleteApp as deleteFirebaseApp,
  FirebaseError,
  type FirebaseApp,
  type FirebaseOptions,
} from 'firebase/app';

/**
 * Brand symbol on every PyricApp. Adapter dispatch reads this to route between
 * sandbox and prod backends. Mirrors the `TARGET_SYMBOL` pattern that
 * `pyric/firestore` uses internally.
 */
export const APP_TARGET = Symbol.for('pyric.app.target');

/** firebase/app's default app name — `'[DEFAULT]'`. */
export const DEFAULT_APP_NAME = '[DEFAULT]';

export type PyricAppTarget = 'sandbox' | 'prod';

export interface SandboxApp {
  readonly [APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  /** Registry name (mirrors firebase/app `FirebaseApp.name`). */
  readonly name: string;
}

export interface ProdApp {
  readonly [APP_TARGET]: 'prod';
  readonly firebaseApp: FirebaseApp;
  /** Registry name (mirrors firebase/app `FirebaseApp.name`). */
  readonly name: string;
}

/**
 * The unified app handle. Carries the backend selection so every adapter can
 * dispatch from a single argument.
 */
export type PyricApp = SandboxApp | ProdApp;

/**
 * The two accepted config shapes. The discriminator is the presence of a
 * `sandbox` field — sandbox handles always carry one, Firebase options never do.
 */
export type InitializeAppConfig = { sandbox: Sandbox } | FirebaseOptions;

// ─── FirebaseError construction (client message text, verbatim) ──────────────
//
// firebase/app's thrown app errors read `Firebase: <message> (<code>).`. When a
// FirebaseError is constructed directly (as here) the message is stored
// verbatim — no wrapper is added — so we pass the fully-formatted string. This
// reproduces the exact `.message` the oracle captured (app-registry-* behaviors)
// while `.code` / `.name` / `instanceof` come from the class itself.

function appError(code: 'duplicate-app' | 'no-app' | 'app-deleted', message: string): FirebaseError {
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

// ─── Registry ────────────────────────────────────────────────────────────────
//
// Module-level, matching firebase/app's `_apps` store (one store per module
// instance). `deletedApps` reproduces the `app/app-deleted` double-delete error:
// firebase flags a deleted app and throws on re-delete, so we do the same.

interface RegistryEntry {
  app: PyricApp;
  config: InitializeAppConfig;
}

const appRegistry = new Map<string, RegistryEntry>();
const deletedApps = new WeakSet<PyricApp>();

/** Reference identity for sandboxes, structural equality for prod options — the
 *  firebase deep-equal-options idempotency rule, adapted to our config union. */
function configEqual(a: InitializeAppConfig, b: InitializeAppConfig): boolean {
  const aSandbox = isSandboxConfig(a);
  const bSandbox = isSandboxConfig(b);
  if (aSandbox !== bSandbox) return false;
  if (aSandbox && bSandbox) return a.sandbox === b.sandbox;
  return firebaseOptionsEqual(a as FirebaseOptions, b as FirebaseOptions);
}

function firebaseOptionsEqual(a: FirebaseOptions, b: FirebaseOptions): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/**
 * Initialize a Pyric app and register it under `name` (default `'[DEFAULT]'`),
 * mirroring `firebase/app.initializeApp`.
 *
 * @example
 * ```ts
 * // Sandbox-backed (tests, agent loops, playground)
 * import { initializeApp } from 'pyric/app';
 * import { initializeSandbox } from 'pyric/sandbox';
 * const app = initializeApp({ sandbox: initializeSandbox() });
 *
 * // Prod-backed (drop-in for existing Firebase code)
 * const app = initializeApp({ apiKey: '...', projectId: '...' });
 *
 * // A second, independent app needs its own name (firebase's rule)
 * const worker = initializeApp({ sandbox: initializeSandbox() }, 'worker');
 * ```
 */
export function initializeApp(config: InitializeAppConfig, name: string = DEFAULT_APP_NAME): PyricApp {
  const existing = appRegistry.get(name);
  if (existing !== undefined) {
    // Same name, equal config → idempotent (return the existing instance);
    // same name, different config → app/duplicate-app, exactly like firebase.
    if (configEqual(existing.config, config)) return existing.app;
    throw duplicateAppError(name);
  }

  let app: PyricApp;
  if (isSandboxConfig(config)) {
    app = { [APP_TARGET]: 'sandbox', sandbox: config.sandbox, name };
  } else {
    // Prod path: delegate to firebase/app initializeApp, threading the name so
    // the underlying FirebaseApp is registered under the same key.
    const firebaseApp = initializeFirebaseApp(config, name === DEFAULT_APP_NAME ? undefined : name);
    app = { [APP_TARGET]: 'prod', firebaseApp, name };
  }
  appRegistry.set(name, { app, config });
  return app;
}

/**
 * Return the registered app for `name` (default `'[DEFAULT]'`). Mirrors
 * `firebase/app.getApp` — including the exact `app/no-app` message on a miss.
 */
export function getApp(name: string = DEFAULT_APP_NAME): PyricApp {
  const entry = appRegistry.get(name);
  if (entry === undefined) throw noAppError(name);
  return entry.app;
}

/**
 * A copy of the list of all registered apps, by identity. Mirrors
 * `firebase/app.getApps`.
 */
export function getApps(): PyricApp[] {
  return Array.from(appRegistry.values(), (entry) => entry.app);
}

/**
 * Remove `app` from the registry, mirroring `firebase/app.deleteApp`. A second
 * `deleteApp` on the same handle throws `app/app-deleted`. Prod-backed apps also
 * delete the underlying firebase/app app (freeing its slot in firebase's own
 * registry so the name can be re-initialized); sandbox-backed apps only
 * deregister — the `Sandbox` handle's lifetime belongs to its creator.
 */
export function deleteApp(app: PyricApp): Promise<void> {
  if (deletedApps.has(app)) throw appDeletedError(app.name);
  const entry = appRegistry.get(app.name);
  if (entry !== undefined && entry.app === app) appRegistry.delete(app.name);
  deletedApps.add(app);
  if (app[APP_TARGET] === 'prod') return deleteFirebaseApp(app.firebaseApp);
  return Promise.resolve();
}

// ─── Re-exported firebase/app diagnostics ────────────────────────────────────
//
// These five symbols are backend-agnostic firebase-SDK-level concerns, so the
// honest mirror is the upstream implementation itself, re-exported. Each is a
// genuine functioning implementation with the exact observable behavior the
// oracle captured — NOT an inert token:
//
//   - FirebaseError  — the error class every app-registry throw uses; re-export
//     makes `instanceof` and `.code` match firebase byte-for-byte.
//   - SDK_VERSION    — the firebase client SDK version pyric mirrors. Re-export
//     ties it to the installed `firebase` package (no hardcoded drift): it IS
//     the version the app-registry rig captured against (fbSdkVersion).
//   - onLog/setLogLevel — the firebase diagnostic-logger seam. Re-export gives a
//     real register+emit implementation against the SAME logger pyric's prod
//     path emits through. In pure sandbox mode there is simply nothing firebase
//     logs, but the functions behave identically to prod (register a handler,
//     set the threshold) — observably, not inertly.
//   - registerVersion — registers a platform-logger version component with
//     firebase. Re-export is the functioning implementation; a malformed call
//     emits the same warning through onLog the oracle recorded.
export { FirebaseError, SDK_VERSION, onLog, setLogLevel, registerVersion } from 'firebase/app';

function isSandboxConfig(config: InitializeAppConfig): config is { sandbox: Sandbox } {
  return typeof config === 'object' && config !== null && 'sandbox' in config;
}

/**
 * Type guard for the sandbox app handle. Adapter dispatch sites use this to
 * route to the sandbox-backed `@pyric/*` implementation.
 */
export function isSandboxApp(app: PyricApp): app is SandboxApp {
  return app[APP_TARGET] === 'sandbox';
}

/**
 * Type guard for the prod app handle. Adapter dispatch sites use this to route
 * to the `firebase/*` modular SDK.
 */
export function isProdApp(app: PyricApp): app is ProdApp {
  return app[APP_TARGET] === 'prod';
}
