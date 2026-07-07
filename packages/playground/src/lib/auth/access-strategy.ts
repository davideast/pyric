/**
 * Auth strategy: prefer the BFF (a persistent, server-held refresh token, so
 * sign-in survives reloads with no popup) when it's configured, else fall back to
 * the GIS token client. The BFF is detected by a one-time probe of
 * `/api/auth/token`; until that resolves "configured", every call delegates to
 * GIS — so when `GIS_CLIENT_SECRET` isn't set, behavior is identical to GIS alone.
 *
 * Re-exports the GIS surface (`getAccessToken` / `isSignedIn` / `signOut` /
 * `hasPriorConsent` / `subscribeAuthState` / `GisAuthError`) so `useAccessToken`
 * swaps to this with a one-line import change.
 */
import * as gis from './gis-token';
import { fetchBffToken, bffSignIn, bffSignOut } from './bff-client';

export { GisAuthError } from './gis-token';

let bffMode: boolean | null = null; // null = unknown, false = GIS, true = BFF
let bffToken: { value: string; expiresAt: number } | null = null;
const LEEWAY_MS = 60_000;

async function probe(): Promise<boolean> {
  if (bffMode !== null) return bffMode;
  try {
    const { status, token } = await fetchBffToken();
    bffMode = status !== 'not-configured';
    if (token) bffToken = { value: token.accessToken, expiresAt: Date.now() + token.expiresIn * 1000 };
  } catch {
    bffMode = false; // probe failed -> stay on GIS
  }
  return bffMode ?? false;
}

// ── Local dev credentials (pyric login / ADC / service account) ──────
// Under `astro dev`, `/api/local-auth/token` mints a token server-side from
// on-disk credentials, so local development needs no GIS (no popup, no
// per-page re-auth). Unavailable locally (no credential -> 401) or in prod
// (route 404s), so we fall through to the BFF/GIS path unchanged.
let localMode: boolean | null = null; // null unknown, false unavailable, true active
let localToken: { value: string; expiresAt: number } | null = null;
let localEmail: string | null = null;
let localSource: string | null = null;

/**
 * Local-credential auth is available under `astro dev`, and — for a local
 * PRODUCTION preview served to your own devices over a private network (e.g.
 * Tailscale `astro preview`) — when the build sets `PUBLIC_ENABLE_LOCAL_AUTH=1`.
 * It stays OFF in a normal deployed build, so visitors never resolve the host
 * machine's credentials.
 */
export const LOCAL_AUTH_ENABLED =
  import.meta.env.DEV ||
  (import.meta.env as Record<string, unknown>).PUBLIC_ENABLE_LOCAL_AUTH === '1';

async function tryLocalToken(): Promise<string | null> {
  if (!LOCAL_AUTH_ENABLED || localMode === false) return null;
  if (localToken && localToken.expiresAt > Date.now() + LEEWAY_MS) return localToken.value;
  try {
    const r = await fetch('/api/local-auth/token', { credentials: 'same-origin' });
    if (!r.ok) {
      localMode = false; // 404 (prod / route off) or 401 (no local credential)
      return null;
    }
    const body = (await r.json()) as {
      accessToken?: string;
      expiresAt?: number;
      email?: string;
      source?: string;
    };
    if (!body.accessToken) {
      localMode = false;
      return null;
    }
    localMode = true;
    localEmail = body.email ?? null;
    localSource = body.source ?? null;
    // The ADC/SA path reports no expiry; default a conservative TTL so we
    // re-mint before the ~1h token lapses (the endpoint refresh is cheap).
    localToken = {
      value: body.accessToken,
      expiresAt: body.expiresAt ?? Date.now() + 30 * 60_000,
    };
    notifyLocalAuth();
    return localToken.value;
  } catch {
    localMode = false;
    return null;
  }
}

/** The active local-credential identity, for the account UI. Null until a
 *  successful local token resolve, or when not on the local path. */
export function localAuthIdentity(): { email: string | null; source: string } | null {
  return localMode === true ? { email: localEmail, source: localSource ?? 'local' } : null;
}

/** Resolve local-dev credentials (if any) and return their identity for the
 *  account UI. Populates the local token cache as a side effect; returns null
 *  when not on the local path (prod) or no credential is available. */
export async function probeLocalAuth(): Promise<{ email: string | null; source: string } | null> {
  await tryLocalToken();
  return localAuthIdentity();
}

export function isSignedIn(): boolean {
  if (localMode === true) return !!localToken && localToken.expiresAt > Date.now() + LEEWAY_MS;
  if (bffMode === true) return !!bffToken && bffToken.expiresAt > Date.now() + LEEWAY_MS;
  return gis.isSignedIn();
}

export function hasPriorConsent(): boolean {
  return gis.hasPriorConsent();
}

// Subscribers get both GIS token changes AND local-credential resolution,
// so `isSignedIn()` (and any UI gated on it) updates once the local probe
// lands — not only after the first `getAccessToken()` call.
const localAuthListeners = new Set<() => void>();
function notifyLocalAuth(): void {
  for (const fn of localAuthListeners) {
    try {
      fn();
    } catch {
      /* a listener throwing must not break the others */
    }
  }
}

export function subscribeAuthState(fn: () => void): () => void {
  const unsubGis = gis.subscribeAuthState(fn);
  localAuthListeners.add(fn);
  return () => {
    unsubGis();
    localAuthListeners.delete(fn);
  };
}

export async function getAccessToken(opts: { forcePrompt?: boolean } = {}): Promise<string> {
  // Local dev credentials win when present — no browser OAuth at all.
  const local = await tryLocalToken();
  if (local) return local;
  if (await probe()) {
    if (bffToken && bffToken.expiresAt > Date.now() + LEEWAY_MS) return bffToken.value;
    const { status, token } = await fetchBffToken();
    if (status === 'signed-in' && token) {
      bffToken = { value: token.accessToken, expiresAt: Date.now() + token.expiresIn * 1000 };
      return token.accessToken;
    }
    if (opts.forcePrompt) {
      bffSignIn(); // full-page redirect; the promise never resolves (page navigates away)
      return new Promise<string>(() => {});
    }
    throw new gis.GisAuthError('interaction-required', 'Sign in to deploy.');
  }
  return gis.getAccessToken(opts);
}

export function signOut(): void {
  gis.signOut();
  if (bffMode === true) {
    bffToken = null;
    void bffSignOut();
  }
  // Local creds live on disk (gcloud/pyric) — the app can't revoke them; just
  // drop the cache + re-probe. To fully sign out locally: `pyric logout` /
  // `gcloud auth application-default revoke`.
  localToken = null;
  localMode = null;
  localEmail = null;
  localSource = null;
}
