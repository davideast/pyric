/**
 * The bearer-token seam the deploy hooks pass as
 * `ProjectScope.resolveToken` to Google APIs (Firebase Hosting,
 * Firestore Admin, IAM).
 *
 * Backed by the GIS token client (`lib/auth/gis-token.ts`). The
 * hook owns React state (signed-in flag, last error, pending-popup
 * flag); the underlying token cache is module-level so it survives
 * unmounts and is shared across every consumer (deploy hooks, the
 * orchestrator, the Deploy tab UI).
 *
 * Failure modes covered (per the `Auth IDP probe` decision log):
 *   - popup-closed       — user dismissed the consent popup
 *   - popup-blocked      — browser prevented the popup from opening
 *   - access-denied      — user denied the requested scope
 *   - scope-not-granted  — `cloud-platform` not in returned scopes
 *   - redirect-uri-mismatch — operator config error in GCP Console
 *   - 401 mid-call       — handled by `withTokenRetry` in
 *                          long-running deploy chains
 *   - script-load-failed — GIS script could not load (offline / CSP)
 *
 * See `packages/playground/README.md` for the one-time GCP
 * Console setup (OAuth client + consent screen + env var).
 */
import { useCallback, useEffect, useState } from 'react';

// Prefer the BFF (persistent server-held refresh token) when configured, else
// fall back to the GIS token client. Identical to GIS when GIS_CLIENT_SECRET is
// unset. See lib/auth/access-strategy.ts.
import {
  GisAuthError,
  getAccessToken,
  hasPriorConsent,
  isSignedIn,
  LOCAL_AUTH_ENABLED,
  probeLocalAuth,
  signOut as gisSignOut,
  subscribeAuthState,
} from '~/lib/auth/access-strategy';

export interface UseAccessTokenResult {
  /** True when a non-expired access token is cached. */
  signedIn: boolean;
  /** Interactive sign-in (forces the consent popup). */
  signIn: () => Promise<void>;
  /** Revoke and clear the cached token. */
  signOut: () => void;
  /**
   * Resolve a fresh access token. Returns the cached value when
   * valid; otherwise silently reissues against the active Google
   * session, falling through to the consent popup if needed.
   *
   * Shape matches `ProjectScope.resolveToken` so deploy hooks can
   * pass this directly. Throws on failure with a typed
   * `GisAuthError`.
   */
  resolveToken: () => Promise<string>;
  /** Last error from `signIn` or `resolveToken`. Cleared on success. */
  error: GisAuthError | null;
  /** True while the consent popup is open. */
  pending: boolean;
}

export function useAccessToken(): UseAccessTokenResult {
  const [signedIn, setSignedIn] = useState<boolean>(() => isSignedIn());
  const [error, setError] = useState<GisAuthError | null>(null);
  const [pending, setPending] = useState<boolean>(false);

  useEffect(() => {
    return subscribeAuthState(() => setSignedIn(isSignedIn()));
  }, []);

  // When local-credential auth is enabled (dev, or a local prod preview built
  // with PUBLIC_ENABLE_LOCAL_AUTH), resolve the machine's credentials (pyric
  // login / ADC / service account) on mount so the app reflects "signed in"
  // without a Google sign-in. probeLocalAuth notifies subscribers, so the effect
  // above flips `signedIn`; the direct set covers the first render too.
  useEffect(() => {
    if (!LOCAL_AUTH_ENABLED) return;
    void probeLocalAuth().then(() => setSignedIn(isSignedIn()));
  }, []);

  // Silent reissue on mount: if the user previously signed in on this
  // origin (the consent marker is set), attempt to mint a fresh token
  // against their active Google session without UI. GIS handles the
  // silent path transparently when prior consent + an active session
  // exist; we swallow any failure so the user isn't surprised by a
  // popup on page load — they can click "Sign in" if needed.
  useEffect(() => {
    if (isSignedIn()) return;
    if (!hasPriorConsent()) return;
    void getAccessToken({ forcePrompt: false }).catch(() => {
      // Silent reissue failed (interaction-required, popup-blocked,
      // etc.) — leave `signedIn` false; the user can click sign-in.
    });
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getAccessToken({ forcePrompt: true });
    } catch (e) {
      setError(toAuthError(e));
      throw e;
    } finally {
      setPending(false);
    }
  }, []);

  const handleSignOut = useCallback(() => {
    gisSignOut();
    setError(null);
  }, []);

  const resolveToken = useCallback(async () => {
    try {
      const token = await getAccessToken({ forcePrompt: false });
      setError(null);
      return token;
    } catch (e) {
      setError(toAuthError(e));
      throw e;
    }
  }, []);

  return {
    signedIn,
    signIn,
    signOut: handleSignOut,
    resolveToken,
    error,
    pending,
  };
}

function toAuthError(e: unknown): GisAuthError {
  if (e instanceof GisAuthError) return e;
  return new GisAuthError('unknown', e instanceof Error ? e.message : String(e));
}
