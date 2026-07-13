/**
 * Sandbox implementation of the client default-app registry.
 *
 * Backend selection happens before this module loads: package resolution maps
 * canonical `firebase/app` imports to this mirror in sandbox processes, while
 * production processes keep resolving the real Firebase package. Consequently
 * this module constructs sandbox apps only and never imports `firebase/app`.
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
 *     `deleteApp` on an already-deleted app. Errors use the app-owned
 *     `FirebaseError` mirror, whose `instanceof Error`, constructor name,
 *     `.code`, and message text match the frozen production observations.
 *   - Idempotency mirror: a same-name re-init with the SAME sandbox returns the
 *     existing app. Sandbox reference identity is the mirror's analog for
 *     Firebase's deep-equal-options path.
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
 * Service mirrors unwrap the sandbox from this handle. Their temporary direct
 * `FirebaseApp` overloads are removed independently as each package becomes
 * sandbox-only; they never turn a PyricApp into a production handle.
 */

import {
  APP_TARGET,
  installDefaultAppResolver,
} from '../sandbox/internal/app-handle.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { Sandbox } from '../sandbox/types/service.js';
import type { InitializeAppConfig, PyricApp } from './types.js';

/** firebase/app's default app name — `'[DEFAULT]'`. */
export const DEFAULT_APP_NAME = '[DEFAULT]';

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

/** Sandbox reference identity mirrors Firebase's equal-options idempotency. */
function configEqual(a: InitializeAppConfig, b: InitializeAppConfig): boolean {
  return a.sandbox === b.sandbox;
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
 * // A second, independent app needs its own name (firebase's rule)
 * const worker = initializeApp({ sandbox: initializeSandbox() }, 'worker');
 * ```
 */
export function initializeApp(config: InitializeAppConfig, name: string = DEFAULT_APP_NAME): PyricApp {
  if (!isSandboxConfig(config)) {
    throw new TypeError(
      'pyric/app: production selection happens by importing firebase/app; ' +
        'the pyric/app mirror accepts { sandbox } only.',
    );
  }
  const existing = appRegistry.get(name);
  if (existing !== undefined) {
    // Same name, equal config → idempotent (return the existing instance);
    // same name, different config → app/duplicate-app, exactly like firebase.
    if (configEqual(existing.config, config)) return existing.app;
    throw duplicateAppError(name);
  }

  const app: PyricApp = { [APP_TARGET]: 'sandbox', sandbox: config.sandbox, name };
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
 * `deleteApp` on the same handle throws `app/app-deleted`. The Sandbox handle's
 * lifetime remains owned by its creator.
 */
export function deleteApp(app: PyricApp): Promise<void> {
  if (deletedApps.has(app)) throw appDeletedError(app.name);
  const entry = appRegistry.get(app.name);
  if (entry !== undefined && entry.app === app) appRegistry.delete(app.name);
  deletedApps.add(app);
  return Promise.resolve();
}

function isSandboxConfig(config: InitializeAppConfig): config is { sandbox: Sandbox } {
  return typeof config === 'object' && config !== null && 'sandbox' in config;
}

installDefaultAppResolver(getApp);
