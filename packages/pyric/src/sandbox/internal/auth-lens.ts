/**
 * Cross-surface AuthLens state, shared by `pyric/auth`, `pyric/firestore`,
 * `pyric/database`, and `pyric/storage` so no mirror surface imports another
 * mirror surface sideways.
 *
 * Stored on `Symbol.for` global slots so source and built `dist` copies loaded
 * in the same process share one active lens and subscriber set.
 */
import type { AuthState } from '../types/auth-state.js';
import type { AuthLens } from '../types/operation.js';
export type { AuthLens };

export interface ResolvedAuthLensState {
  auth: AuthState;
  bypassRules: boolean;
}

const AUTH_LENS_SLOT = Symbol.for('pyric.sandbox.authLens');
const AUTH_LENS_LISTENERS = Symbol.for('pyric.sandbox.authLensListeners');

type AuthLensGlobal = {
  [AUTH_LENS_SLOT]?: AuthLens;
  [AUTH_LENS_LISTENERS]?: Set<(lens: AuthLens | undefined) => void>;
};

function listeners(): Set<(lens: AuthLens | undefined) => void> {
  const slot = globalThis as AuthLensGlobal;
  slot[AUTH_LENS_LISTENERS] ??= new Set();
  return slot[AUTH_LENS_LISTENERS];
}

/** Switch the active AuthLens for subsequent data operations. */
export function switchAuthLens(lens: AuthLens | undefined): void {
  const slot = globalThis as AuthLensGlobal;
  if (lens && lens.mode === 'app-session') {
    delete slot[AUTH_LENS_SLOT];
  } else if (lens === undefined) {
    delete slot[AUTH_LENS_SLOT];
  } else {
    slot[AUTH_LENS_SLOT] = lens;
  }
  const current = slot[AUTH_LENS_SLOT];
  for (const cb of [...listeners()]) {
    cb(current);
  }
}

/** Return the currently active AuthLens, or undefined if using the default app session. */
export function getAuthLens(): AuthLens | undefined {
  return (globalThis as AuthLensGlobal)[AUTH_LENS_SLOT];
}

/** Subscribe to AuthLens changes. Returns an unsubscribe function. */
export function onAuthLensChanged(cb: (lens: AuthLens | undefined) => void): () => void {
  const set = listeners();
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

/** Resolve effective identity and admin rules-bypass state for a live listener or handle. */
export function resolveAuthLensState(
  lens: AuthLens | undefined,
  fallback: AuthState,
): ResolvedAuthLensState {
  if (lens?.mode === 'admin') {
    return { auth: null, bypassRules: true };
  }
  if (lens?.mode === 'anon') {
    return { auth: null, bypassRules: false };
  }
  if (lens?.mode === 'as') {
    const impersonated: NonNullable<AuthState> = { uid: lens.uid };
    if (lens.tenant !== undefined) impersonated.tenant = lens.tenant;
    if (lens.token !== undefined) impersonated.token = lens.token;
    return { auth: impersonated, bypassRules: false };
  }
  return { auth: fallback, bypassRules: false };
}
