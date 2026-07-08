/**
 * Dispatch routing for `pyric/auth`.
 *
 * Each {@link Auth} handle carries a hidden {@link Target} discriminator
 * via {@link TARGET_SYMBOL}. Free functions read it through
 * {@link targetOf} and switch on `target.kind`, mirroring the same
 * pattern `pyric/firestore` uses (see
 * `packages/firestore/src/index.ts`).
 *
 * Sandbox-side state (the in-memory user DB, listener set,
 * mock-result registry) lives on the {@link SandboxBackend} attached
 * to the sandbox target; the prod-side state lives on the upstream
 * `fb.Auth` handle. Both surfaces look the same to consumer code.
 */

import type { Sandbox } from 'pyric/sandbox';
import type * as fb from 'firebase/auth';

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
}

/** Prod dispatch target — wraps an upstream `firebase/auth.Auth`. */
export interface ProdTarget {
  kind: 'prod';
  auth: fb.Auth;
}

export type Target = SandboxTarget | ProdTarget;

/**
 * Recover the dispatch target for an {@link Auth} handle. Throws if
 * the handle wasn't produced by this package — the brand is the
 * only way in.
 */
export function targetOf(auth: Auth): Target {
  const t = (auth as { [TARGET_SYMBOL]?: Target })[TARGET_SYMBOL];
  if (!t) {
    throw new TypeError(
      'pyric/auth: unrecognized Auth handle — was it produced by getAuth(...)?',
    );
  }
  return t;
}
