/**
 * Resolve the user identifier sessions are scoped to.
 *
 * Two regimes:
 *   - Signed in via GIS: use the `sub` claim from the userinfo cache.
 *     Stable across sessions, identical across this user's devices once
 *     they sign in there.
 *   - Signed out: synthesize a `local-{uuid}` pseudo-id and pin it in
 *     localStorage. Sessions started signed-out get listed under this
 *     id; the future "rebind on sign-in" track will migrate them to
 *     the GIS sub when the user first authenticates.
 *
 * Sessions never silently fall through one regime to the other —
 * `getCurrentUserId()` returns whichever the caller has *right now*.
 * Re-call after sign-in (or subscribe to the GIS auth state) to pick
 * up the rebind.
 */

import { getUserInfo } from '../auth/gis-token';

const LOCAL_USER_ID_KEY = 'pyric:playground:local-user-id';

/**
 * Read the persisted local pseudo-id, minting one on first call. Each
 * call returns the same id within a browser profile until the user
 * clears storage. Browser-only — server-side returns a fresh id every
 * call, which is fine because the home page never renders sessions
 * during SSR (the list is a client island).
 */
function getOrCreateLocalUserId(): string {
  if (typeof window === 'undefined') {
    // No persistence available on the server; return a placeholder
    // that won't match any real user. Real reads happen client-side.
    return 'local-ssr';
  }
  try {
    const existing = window.localStorage.getItem(LOCAL_USER_ID_KEY);
    if (existing && existing.startsWith('local-')) return existing;
  } catch {
    // localStorage may be unavailable (privacy mode); fall through.
  }
  const fresh = `local-${cryptoRandomUUID()}`;
  try {
    window.localStorage.setItem(LOCAL_USER_ID_KEY, fresh);
  } catch {
    // Best-effort persist; if it fails the user gets a fresh id per
    // page load. Sessions stored under the previous id are still in
    // the sandbox; they just won't surface in the next render's list.
  }
  return fresh;
}

function cryptoRandomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID — shouldn't
  // hit in browsers we target, but keeps the helper portable for tests.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Resolve the active user id for sessions. Returns the GIS `sub` claim
 * when signed in; otherwise a stable `local-{uuid}` pinned to this
 * browser profile.
 *
 * Pure: no network, no async, no side effects beyond minting the
 * local id on first call. Safe to call from render paths.
 */
export function getCurrentUserId(): string {
  const info = getUserInfo();
  if (info?.sub) return info.sub;
  return getOrCreateLocalUserId();
}

/**
 * True when the active user id comes from GIS (a real Google account)
 * rather than the local-uuid fallback. The home page uses this to
 * decide whether to surface the "Promote" action — promotion only
 * makes sense once we have a real account to write into.
 */
export function isSignedInUser(userId: string): boolean {
  return !userId.startsWith('local-');
}
