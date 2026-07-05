/**
 * `pyric-admin/app` — Phase 3 initializeApp surface (ADR-001 D6).
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
 *   - Per-subpath adapter dispatch via the brand: implemented in
 *     `pyric-admin/{auth,database,storage}` via structural
 *     checks on the `app` argument. Phase 4 commits use property
 *     probing today; cutover swaps to brand-symbol reads.
 */

import type { Sandbox } from 'pyric/sandbox';
import {
  initializeApp as initializeFirebaseAdminApp,
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

export interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
}

export interface ProdAdminApp {
  readonly [ADMIN_APP_TARGET]: 'prod';
  readonly adminApp: AdminApp;
}

export type PyricAdminApp = SandboxAdminApp | ProdAdminApp;

export type InitializeAdminAppConfig = { sandbox: Sandbox } | AppOptions;

/**
 * Initialize a Pyric admin app.
 *
 * @example
 * ```ts
 * // Prod-backed
 * import { initializeApp } from 'pyric-admin/app';
 * import { applicationDefault } from 'firebase-admin/app';
 * const app = initializeApp({ credential: applicationDefault() });
 *
 * // Sandbox-backed
 * import { initializeSandbox } from 'pyric/sandbox';
 * const app = initializeApp({ sandbox: initializeSandbox() });
 * ```
 */
export function initializeApp(config: InitializeAdminAppConfig): PyricAdminApp {
  if (isSandboxConfig(config)) {
    return {
      [ADMIN_APP_TARGET]: 'sandbox',
      sandbox: config.sandbox,
    };
  }
  const adminApp = initializeFirebaseAdminApp(config);
  return {
    [ADMIN_APP_TARGET]: 'prod',
    adminApp,
  };
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
