/**
 * `pyric-admin/app` — Phase 3 initializeApp surface (ADR-001 D6) plus the
 * default-app registry that mirrors firebase-admin's in-process app store.
 *
 * Mirror shape: `pyric-admin/app` is the single entry point where the
 * sandbox-vs-prod choice is made for the admin surface. Every
 * `pyric-admin/*` subpath inspects the handle's brand for backend dispatch.
 *
 * Registry parity with `firebase-admin/app` (captured under
 * `scripts/oracle/observations/admin-app-*.json`, firebase-admin 13.10):
 *
 *   - `initializeApp(config?, name?)` registers an app by name, defaulting
 *     to the `'[DEFAULT]'` app when no name is given.
 *   - `getApp(name?)` / `getApps()` / `deleteApp(app)` mirror the four
 *     lifecycle functions firebase-admin/app exports.
 *   - Accessors (`getDatabase`/`getAuth`/`getFirestore`/`getStorage`) called
 *     with NO argument resolve the default app; with nothing initialized they
 *     throw the captured `app/no-app` `FirebaseAppError`.
 *   - Duplicate / invalid-name / auto-init-mismatch errors reuse
 *     firebase-admin's own `FirebaseAppError` + `AppErrorCodes` so the code,
 *     message shape, and error-class contract match the capture exactly.
 *
 * One deliberate, scoped divergence — the legacy fresh-handle factory:
 *   Re-initializing the IMPLICIT default (`initializeApp(config)` with a
 *   config but no explicit name) is last-write-wins rather than
 *   `duplicate-app`. This preserves the pre-registry behavior that the
 *   existing pyric-admin test-suite relies on (dozens of call sites do
 *   `initializeApp({ sandbox })` per test, each expecting an independent
 *   handle against a fresh sandbox). Every OTHER shape — no-arg re-init,
 *   any explicitly-named re-init — mirrors firebase-admin exactly.
 */

import type { Sandbox } from 'pyric/sandbox';
import {
  initializeApp as initializeFirebaseAdminApp,
  deleteApp as deleteFirebaseAdminApp,
  FirebaseAppError,
  AppErrorCodes,
  type App as AdminApp,
  type AppOptions,
} from 'firebase-admin/app';

/**
 * Brand on every PyricAdminApp. Matches the symbol used in
 * `pyric/app` so a future shared `pyric/runtime` package can
 * unify dispatch helpers across both packages.
 */
export const ADMIN_APP_TARGET = Symbol.for('pyric.admin.app.target');

/** The name firebase-admin gives the default app. */
export const DEFAULT_APP_NAME = '[DEFAULT]';

export type PyricAdminAppTarget = 'sandbox' | 'prod';

export interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  /** App name — `'[DEFAULT]'` for the default app, else the name passed to
   *  `initializeApp`. Optional so hand-built test handles stay valid. */
  readonly name?: string;
  readonly sandbox: Sandbox;
}

export interface ProdAdminApp {
  readonly [ADMIN_APP_TARGET]: 'prod';
  readonly name?: string;
  readonly adminApp: AdminApp;
}

export type PyricAdminApp = SandboxAdminApp | ProdAdminApp;

export type InitializeAdminAppConfig = { sandbox: Sandbox } | AppOptions;

// ─── Default-app registry ────────────────────────────────────────────────

interface RegistryEntry {
  app: PyricAdminApp;
  /** `true` when `initializeApp` was called with no config (auto-init). */
  autoInit: boolean;
  /** The original config, used for firebase-admin-style equality on re-init. */
  config: InitializeAdminAppConfig | undefined;
}

/** Process-global registry, keyed by app name — mirrors firebase-admin's
 *  `AppStore`. */
const appRegistry = new Map<string, RegistryEntry>();

/**
 * firebase-admin's published typings declare `FirebaseAppError` with only the
 * base `Error` constructor, but the real runtime class is
 * `new AppError(code, message)` (code becomes `app/<code>`). We use the
 * genuine class so the thrown error's class, `.code`, and message match the
 * Phase-A capture exactly — the cast just recovers the real 2-arg signature.
 */
const AppError = FirebaseAppError as unknown as new (
  code: string,
  message: string,
) => FirebaseAppError;

/**
 * Initialize a Pyric admin app and register it by name.
 *
 * @param config Sandbox config (`{ sandbox }`) or firebase-admin `AppOptions`
 *   for a prod-backed app. Omit for a firebase-admin auto-initialized app.
 * @param name App name; defaults to `'[DEFAULT]'`.
 *
 * @example
 * ```ts
 * // Sandbox-backed default app + no-arg accessor resolution
 * import { initializeApp } from 'pyric-admin/app';
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getDatabase } from 'pyric-admin/database';
 * initializeApp({ sandbox: initializeSandbox() });
 * const db = getDatabase(); // resolves the default app
 * ```
 */
export function initializeApp(
  config?: InitializeAdminAppConfig,
  name: string = DEFAULT_APP_NAME,
): PyricAdminApp {
  validateAppName(name);
  const autoInit = config === undefined;
  const explicitName = name !== DEFAULT_APP_NAME;
  const existing = appRegistry.get(name);

  if (existing) {
    // Scoped legacy divergence: an implicit-default init carrying a config is
    // a fresh-handle factory (last-write-wins), NOT a duplicate-app error.
    // For the SANDBOX config this is a plain in-process overwrite below; for a
    // PROD config `buildApp` re-enters firebase-admin, which throws its own
    // faithful duplicate-app/idempotent result.
    const legacyImplicitDefault = !explicitName && !autoInit && isSandboxConfig(config!);
    if (!legacyImplicitDefault) {
      if (existing.autoInit !== autoInit) {
        throw new AppError(
          AppErrorCodes.INVALID_APP_OPTIONS,
          `A Firebase app named "${name}" already exists with a different configuration.`,
        );
      }
      // Both auto-init → idempotent (no config to compare).
      if (autoInit) return existing.app;
      // Same config → idempotent; different config → duplicate-app.
      if (configsEqual(existing.config, config)) return existing.app;
      throw new AppError(
        AppErrorCodes.DUPLICATE_APP,
        `A Firebase app named "${name}" already exists with a different configuration.`,
      );
    }
  }

  const app = buildApp(config, name);
  appRegistry.set(name, { app, autoInit, config });
  return app;
}

/**
 * Returns the registered {@link PyricAdminApp} for `name` (default
 * `'[DEFAULT]'`). Throws the captured `app/no-app` `FirebaseAppError` when no
 * such app has been initialized.
 */
export function getApp(name: string = DEFAULT_APP_NAME): PyricAdminApp {
  const entry = appRegistry.get(name);
  if (!entry) {
    const message =
      name === DEFAULT_APP_NAME
        ? 'The default Firebase app does not exist. Make sure you call initializeApp() before using any of the Firebase services.'
        : `Firebase app named "${name}" does not exist. Make sure you call initializeApp() before using any of the Firebase services.`;
    throw new AppError(AppErrorCodes.NO_APP, message);
  }
  return entry.app;
}

/** A snapshot array of all initialized apps (mirrors `firebase-admin/app`). */
export function getApps(): PyricAdminApp[] {
  return [...appRegistry.values()].map((entry) => entry.app);
}

/**
 * Removes `app` from the registry (and, for prod apps, from firebase-admin's
 * own registry). Throws `app/invalid-argument` for a non-app value, matching
 * the Phase-A capture. Returns a Promise, like `firebase-admin/app`.
 */
export async function deleteApp(app: PyricAdminApp): Promise<void> {
  if (app === null || typeof app !== 'object' || !(ADMIN_APP_TARGET in app)) {
    throw new AppError(AppErrorCodes.INVALID_ARGUMENT, 'Invalid app argument.');
  }
  for (const [name, entry] of appRegistry) {
    if (entry.app === app) {
      appRegistry.delete(name);
      break;
    }
  }
  if (app[ADMIN_APP_TARGET] === 'prod') {
    await deleteFirebaseAdminApp(app.adminApp);
  }
}

/**
 * Resolve the app an accessor should use: the explicit handle when one is
 * passed, else the default app. Throws the captured `app/no-app`
 * `FirebaseAppError` when no argument is given and no default app exists.
 * Shared by every `pyric-admin/*` accessor so no-arg resolution and the
 * no-app error are identical across subpaths.
 */
export function resolveApp(app?: PyricAdminApp): PyricAdminApp {
  if (app !== undefined) return app;
  return getApp();
}

// ─── Internals ─────────────────────────────────────────────────────────────

function buildApp(
  config: InitializeAdminAppConfig | undefined,
  name: string,
): PyricAdminApp {
  if (config !== undefined && isSandboxConfig(config)) {
    return { [ADMIN_APP_TARGET]: 'sandbox', name, sandbox: config.sandbox };
  }
  const adminApp = initializeFirebaseAdminApp(config as AppOptions | undefined, name);
  return { [ADMIN_APP_TARGET]: 'prod', name, adminApp };
}

function validateAppName(name: string): void {
  if (typeof name !== 'string' || name === '') {
    throw new AppError(
      AppErrorCodes.INVALID_APP_NAME,
      `Invalid Firebase app name "${name}" provided. App name must be a non-empty string.`,
    );
  }
}

/** firebase-admin-style config equality for re-init. Sandbox configs are equal
 *  iff they carry the same `Sandbox` instance; prod `AppOptions` compare by
 *  structural JSON (sufficient for the databaseURL-shaped captures). A sandbox
 *  config and a prod config are never equal. */
function configsEqual(
  a: InitializeAdminAppConfig | undefined,
  b: InitializeAdminAppConfig | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aSandbox = isSandboxConfig(a);
  const bSandbox = isSandboxConfig(b);
  if (aSandbox || bSandbox) {
    return aSandbox && bSandbox && a.sandbox === b.sandbox;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

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

/**
 * TEST-ONLY: clear the process-global registry (and best-effort tear down any
 * prod apps it created in firebase-admin's registry). firebase-admin has no
 * public reset; the oracle-conformance suite uses this to isolate the shared
 * module-level registry between cases. Not part of the mirror surface.
 */
export async function __resetAppRegistryForTests(): Promise<void> {
  const entries = [...appRegistry.values()];
  appRegistry.clear();
  for (const entry of entries) {
    if (entry.app[ADMIN_APP_TARGET] === 'prod') {
      try {
        await deleteFirebaseAdminApp((entry.app as ProdAdminApp).adminApp);
      } catch {
        // Already torn down / never fully registered — nothing to clean.
      }
    }
  }
}
