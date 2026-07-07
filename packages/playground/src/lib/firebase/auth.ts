/**
 * Google sign-in for the playground — backed by Google Identity
 * Services (`lib/auth/gis-token`).
 *
 * This file is a thin compatibility shim. The original implementation
 * used Firebase Auth's `signInWithPopup`/`signInWithRedirect` against
 * the playground's own Firebase project to capture a Google OAuth
 * access token; that token's expiry could not be silently refreshed,
 * which is why the deploy flow needed its own GIS-based auth
 * (`lib/auth/gis-token`).
 *
 * The migration consolidates onto a single sign-in surface: GIS owns
 * the auth flow + token cache + userinfo. This module preserves the
 * legacy `SignedInUser` shape and `useGoogleSession` hook so callers
 * (`AuthModal`, diagnostics tools) don't need to migrate in
 * lockstep. The `accessToken` returned here is the same GIS-minted
 * token the deploy hooks use — one sign-in, one token, both flows.
 *
 * What's gone vs. the old shape:
 *   - `signInWithRedirect` / `getRedirectResult` (GIS uses a popup
 *      with silent reissue; no redirect dance needed). The
 *      `startGoogleSignInRedirect` + `completeRedirectSignIn` exports
 *      stay as no-ops for callers that still reference them.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  GisAuthError,
  getAccessToken,
  getUserInfo,
  hasPriorConsent,
  isSignedIn,
  signOut as gisSignOut,
  subscribeAuthState,
  type GisUserInfo,
} from '~/lib/auth/gis-token';

/**
 * The signed-in user shape consumers expect. Mirrors the original
 * `SignedInUser` produced by Firebase Auth's `credentialFromResult`;
 * fields now come from GIS userinfo + the in-memory token cache.
 */
export interface SignedInUser {
  uid: string;
  email: string;
  name: string | null;
  picture: string | null;
  /**
   * OAuth access token with `cloud-platform` scope. Use as
   * `Authorization: Bearer <token>` against Firebase Management API,
   * Storage REST, Firestore Admin, IAM — same shape the deploy hooks
   * use via `useAccessToken().resolveToken`.
   */
  accessToken: string;
  /** Epoch ms when `accessToken` is considered expired locally. */
  expiresAt: number;
}

const TOKEN_LIFETIME_FALLBACK_MS = 55 * 60 * 1000;

function userFromCache(info: GisUserInfo, accessToken: string): SignedInUser {
  return {
    uid: info.sub,
    email: info.email,
    name: info.name || null,
    picture: info.picture || null,
    accessToken,
    expiresAt: Date.now() + TOKEN_LIFETIME_FALLBACK_MS,
  };
}

async function readCurrentUser(): Promise<SignedInUser | null> {
  if (!isSignedIn()) return null;
  const info = getUserInfo();
  if (!info) return null;
  // `isSignedIn()` only returns true when the cache has a non-expired
  // token; pulling it via `getAccessToken({forcePrompt: false})` is a
  // sync no-op against the cache in that case.
  const token = await getAccessToken({ forcePrompt: false });
  return userFromCache(info, token);
}

/**
 * Pop the Google sign-in dialog (via GIS). Returns the freshly
 * minted `SignedInUser` shape. Throws on user-cancel /
 * popup-blocked — same contract as the legacy implementation.
 */
export async function signInWithGoogle(): Promise<SignedInUser> {
  const accessToken = await getAccessToken({ forcePrompt: true });
  // Wait briefly for userinfo to populate. The userinfo fetch is
  // fire-and-forget from gis-token, so the profile cache may not be
  // ready the instant getAccessToken returns. A short poll covers
  // 99% of cases without forcing the caller to await two round-trips.
  let info = getUserInfo();
  if (!info) {
    for (let i = 0; i < 20 && !info; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      info = getUserInfo();
    }
  }
  if (!info) {
    // Fall back to a token-only result; callers that need profile data
    // can re-read via useGoogleSession once the cache lands.
    return {
      uid: '',
      email: '',
      name: null,
      picture: null,
      accessToken,
      expiresAt: Date.now() + TOKEN_LIFETIME_FALLBACK_MS,
    };
  }
  return userFromCache(info, accessToken);
}

/**
 * Legacy redirect-flow entry points. GIS doesn't need a redirect
 * fallback — its popup is silently reissuable and works under
 * Safari/Brave/Firefox-strict without the third-party-cookie
 * gymnastics the old `signInWithRedirect` was designed to work
 * around. Kept as no-ops so older call sites don't crash.
 */
export async function startGoogleSignInRedirect(): Promise<void> {
  await signInWithGoogle();
}

export async function completeRedirectSignIn(): Promise<SignedInUser | null> {
  return readCurrentUser();
}

export async function signOutCurrentUser(): Promise<void> {
  gisSignOut();
}

/**
 * React hook exposing the current signed-in user. Returns `null`
 * until sign-in completes; surfaces `loading: true` while a silent
 * reissue is in flight after a page refresh.
 */
export function useGoogleSession(): {
  user: SignedInUser | null;
  loading: boolean;
  error: GisAuthError | null;
} {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<GisAuthError | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await readCurrentUser();
      setUser(next);
    } catch (e) {
      setError(e instanceof GisAuthError ? e : null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = subscribeAuthState(() => {
      void refresh();
    });
    return unsub;
  }, [refresh]);

  // Silent-reissue path on mount: if the user previously consented
  // and we don't currently have a token (page refresh), GIS will
  // re-issue against the active Google session without UI. Errors
  // are swallowed so the user isn't surprised by a popup on load —
  // they can click sign-in if needed.
  useEffect(() => {
    if (isSignedIn()) return;
    if (!hasPriorConsent()) return;
    setLoading(true);
    void getAccessToken({ forcePrompt: false })
      .catch((e) => {
        if (e instanceof GisAuthError) setError(e);
      })
      .finally(() => setLoading(false));
  }, []);

  return { user, loading, error };
}

/**
 * @deprecated Prefer `useGoogleSession`. Kept for older imports that
 * relied on the slimmer hook name.
 */
export const useSignedInUser = useGoogleSession;
