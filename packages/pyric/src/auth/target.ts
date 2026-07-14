/**
 * Dispatch routing for `pyric/auth`.
 *
 * Each {@link Auth} handle carries its sandbox backend behind
 * {@link TARGET_SYMBOL}. Production selection happens before this package
 * loads, at the Vite/import-map or Node register boundary.
 */

import type { Sandbox } from 'pyric/sandbox';

import type { SandboxBackend } from './sandbox-backend.js';
import type { Auth } from './types.js';
import { TARGET_SYMBOL } from './types.js';

/** Sandbox dispatch target — carries the per-sandbox `SandboxBackend`
 *  that owns the in-memory user DB and listener registry, plus the
 *  underlying {@link Sandbox} the backend writes `currentUser`
 *  through. */
export interface SandboxTarget {
  kind: 'sandbox';
  sandbox: Sandbox;
  backend: SandboxBackend;
  own?: (cleanup: () => void) => () => void;
  assertAlive?: () => void;
}

export type Target = SandboxTarget;

/**
 * Recover the dispatch target for an {@link Auth} handle. Throws if
 * the handle wasn't produced by this package — the brand is the
 * only way in.
 */
export function targetOf(auth: Auth, includeDeleted = false): Target {
  const t = (auth as { [TARGET_SYMBOL]?: Target })[TARGET_SYMBOL];
  if (!t) {
    throw new TypeError(
      'pyric/auth: unrecognized Auth handle — was it produced by getAuth(...)?',
    );
  }
  if (!includeDeleted) t.assertAlive?.();
  return t;
}
