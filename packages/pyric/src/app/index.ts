/**
 * `pyric/app` — Phase 3 initializeApp surface (ADR-001 D5).
 *
 * Mirror shape: at cutover this becomes `pyric/app` and is the single
 * entry point where the sandbox-vs-prod choice is made. Every other
 * subpath (`getFirestore(app)`, `getAuth(app)`, `getDatabase(app)`,
 * `getStorage(app)`) is backend-agnostic — they inspect the `PyricApp`
 * handle for the brand and route accordingly.
 *
 * Current shadow scope:
 *   - `initializeApp({ sandbox })` — sandbox-backed app handle (live).
 *   - `initializeApp(firebaseConfig)` — prod-backed app handle (live).
 *   - Adapter dispatch (the `getFirestore(app)` etc. wrappers) is
 *     **deferred to cutover**: the adapter subpaths still re-export
 *     from `pyric/firestore` / `pyric/auth` / etc., which take their
 *     own per-backend handles. Implementing the wrap requires hiding
 *     the existing `getFirestore` overloads behind the unified
 *     handle, which lands cleanly when source folds into
 *     `packages/pyric/src/*` and the existing entry points go away.
 *
 * The handle shape is finalized here so consumers can begin coding
 * against it (and stubs throw on the deferred call).
 */

import type { Sandbox } from 'pyric/sandbox';
import { initializeApp as initializeFirebaseApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';

/**
 * Brand symbol on every PyricApp. Adapter dispatch reads this to
 * route between sandbox and prod backends. Mirrors the
 * `TARGET_SYMBOL` pattern that `pyric/firestore` uses internally.
 */
export const APP_TARGET = Symbol.for('pyric.app.target');

export type PyricAppTarget = 'sandbox' | 'prod';

export interface SandboxApp {
  readonly [APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
}

export interface ProdApp {
  readonly [APP_TARGET]: 'prod';
  readonly firebaseApp: FirebaseApp;
}

/**
 * The unified app handle. Carries the backend selection so every
 * adapter can dispatch from a single argument.
 */
export type PyricApp = SandboxApp | ProdApp;

/**
 * The two accepted config shapes. The discriminator is the presence
 * of a `sandbox` field — sandbox handles always carry one, Firebase
 * options never do.
 */
export type InitializeAppConfig = { sandbox: Sandbox } | FirebaseOptions;

/**
 * Initialize a Pyric app.
 *
 * @example
 * ```ts
 * // Sandbox-backed (tests, agent loops, playground)
 * import { initializeApp } from 'pyric/app';
 * import { initializeSandbox } from 'pyric/sandbox';
 * const app = initializeApp({ sandbox: initializeSandbox() });
 *
 * // Prod-backed (drop-in for existing Firebase code)
 * const app = initializeApp({
 *   apiKey: '...', projectId: '...', // ...standard FirebaseOptions
 * });
 * ```
 */
export function initializeApp(config: InitializeAppConfig): PyricApp {
  if (isSandboxConfig(config)) {
    return {
      [APP_TARGET]: 'sandbox',
      sandbox: config.sandbox,
    };
  }
  // Prod path: delegate to firebase/app initializeApp.
  const firebaseApp = initializeFirebaseApp(config);
  return {
    [APP_TARGET]: 'prod',
    firebaseApp,
  };
}

function isSandboxConfig(config: InitializeAppConfig): config is { sandbox: Sandbox } {
  return typeof config === 'object' && config !== null && 'sandbox' in config;
}

/**
 * Type guard for the sandbox app handle. Adapter dispatch sites use
 * this to route to the sandbox-backed `@pyric/*` implementation.
 */
export function isSandboxApp(app: PyricApp): app is SandboxApp {
  return app[APP_TARGET] === 'sandbox';
}

/**
 * Type guard for the prod app handle. Adapter dispatch sites use
 * this to route to the `firebase/*` modular SDK.
 */
export function isProdApp(app: PyricApp): app is ProdApp {
  return app[APP_TARGET] === 'prod';
}
