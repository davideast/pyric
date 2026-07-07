/**
 * Google Identity Services (GIS) token client. Mints OAuth access
 * tokens with `cloud-platform` scope for the playground's
 * cross-project deploy calls (Firebase Hosting / Firestore Admin /
 * IAM REST APIs).
 *
 * Why GIS and not Firebase Auth: the `Auth IDP probe` spike
 * established that Firebase Auth's `GoogleAuthProvider` does NOT
 * silently refresh the underlying OAuth access token — it's one-shot
 * per popup, breaking the playground's "deploy → wait → re-deploy"
 * loop after ~1h. GIS's `tokenClient.requestAccessToken({ prompt: '' })`
 * issues new tokens silently against an active Google session.
 *
 * Cross-project authorization is handled by OAuth scopes + IAM:
 * tokens minted here are bound to client_id + user identity, NOT to
 * a GCP project, so a single sign-in on the playground host
 * authorizes calls against any project the user has IAM rights for.
 * See the milestone doc's "Auth IDP probe" decision-log entry for
 * the long version.
 *
 * Module-level state: cached access token (memory only — never
 * persisted to localStorage) and a singleton token client. The
 * cache is wiped on refresh; cross-refresh continuity comes from
 * GIS silent reissue against the user's active Google session,
 * gated by the `pyric:gis-consented` localStorage marker (set when
 * the user successfully signs in, cleared on `signOut`). Browser-
 * only — every entry point checks `typeof window`.
 */

/**
 * Scopes the playground's GIS sign-in requests. `openid` + `email` +
 * `profile` enable userinfo via Google's well-known endpoint, which
 * is how we surface the signed-in user's display name / picture / email
 * to the playground UI without standing up a separate Firebase Auth
 * flow. `cloud-platform` covers every Google API call the playground
 * needs (Firebase Hosting, Firestore Admin, IAM, Storage REST).
 */
const SCOPE = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');
const REQUIRED_API_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
/** localStorage key recording prior consent — see file docstring. */
const CONSENTED_STORAGE_KEY = 'pyric:gis-consented';
/** Refresh the token if it's within this much of expiry. */
const TOKEN_LEEWAY_MS = 60_000;

// ─── Types ───────────────────────────────────────────────────────────

export type GisErrorCode =
  | 'no-client-id'
  | 'script-load-failed'
  | 'popup-closed'
  | 'popup-blocked'
  | 'access-denied'
  | 'interaction-required'
  | 'scope-not-granted'
  | 'redirect-uri-mismatch'
  | 'unknown';

export class GisAuthError extends Error {
  constructor(
    public code: GisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GisAuthError';
  }
}

// Minimal type declarations for the GIS token-client surface.
// `@types/google.accounts` exists upstream but ships a much larger
// surface than we need; inlining keeps the dep graph small.
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface TokenError {
  type?: string;
  message?: string;
}
interface GoogleTokenClient {
  callback: (response: TokenResponse) => void;
  error_callback?: (error: TokenError) => void;
  requestAccessToken(overrideConfig?: { prompt?: '' | 'consent' }): void;
}
declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: TokenError) => void;
          }): GoogleTokenClient;
          revoke(token: string, callback?: () => void): void;
          hasGrantedAllScopes?: (response: TokenResponse, ...scopes: string[]) => boolean;
        };
      };
    };
  }
}

interface CachedToken {
  value: string;
  expiresAt: number;
  scope: string;
}

export interface GisUserInfo {
  /** Stable Google identifier (the `sub` claim). */
  sub: string;
  email: string;
  /** Display name (may be empty if the user hasn't set one). */
  name: string;
  /** Avatar URL (may be empty). */
  picture: string;
}

// ─── Test-only token hatch ───────────────────────────────────────────
// E2E tests need to bypass the GIS popup (Google blocks automation).
// When `window.__pyricTestToken` is a non-empty string AND we're
// running under `astro dev`, every entry point that would otherwise
// touch GIS short-circuits to the injected value. Gated on
// `import.meta.env.DEV` so Vite tree-shakes the hatch out of any
// production build — `astro build` produces a bundle with no
// reference to `__pyricTestToken` at all.
declare global {
  interface Window {
    __pyricTestToken?: string;
  }
}
function readInjectedTestToken(): string | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  const t = window.__pyricTestToken;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

// ─── Module state ────────────────────────────────────────────────────

let cachedToken: CachedToken | null = null;
let cachedUserInfo: GisUserInfo | null = null;
let tokenClient: GoogleTokenClient | null = null;
let scriptLoadPromise: Promise<void> | null = null;

const USERINFO_STORAGE_KEY = 'pyric:gis-userinfo';

// Hydrate the userinfo cache eagerly from localStorage so the UI can
// render the signed-in user's identity immediately on page load, even
// before the silent reissue completes. The token cache stays empty
// until reissue finishes — only the profile (which is safe to persist)
// short-circuits the cold start.
if (typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(USERINFO_STORAGE_KEY);
    if (raw) cachedUserInfo = JSON.parse(raw) as GisUserInfo;
  } catch (e) {
    console.warn('[gis-token] userinfo hydrate failed:', e);
  }
}
const listeners = new Set<() => void>();

// ─── Internal helpers ────────────────────────────────────────────────

function readClientId(): string {
  // Astro/Vite injects via `import.meta.env` at build time. The
  // `PUBLIC_` prefix is required for it to ship to the browser.
  const id = (import.meta as { env?: Record<string, string | undefined> }).env
    ?.PUBLIC_GIS_CLIENT_ID;
  if (!id) {
    throw new GisAuthError(
      'no-client-id',
      'PUBLIC_GIS_CLIENT_ID env var is not set. See packages/playground/README.md.',
    );
  }
  return id;
}

async function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') {
    throw new GisAuthError('script-load-failed', 'GIS requires a browser environment');
  }
  if (window.google?.accounts?.oauth2) return;
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[src="${GIS_SCRIPT_SRC}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () =>
        reject(new GisAuthError('script-load-failed', 'Failed to load GIS script')),
      );
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromise = null;
      reject(new GisAuthError('script-load-failed', 'Failed to load GIS script'));
    };
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

function getOrCreateTokenClient(): GoogleTokenClient {
  if (tokenClient) return tokenClient;
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new GisAuthError('script-load-failed', 'GIS oauth2 namespace not present after load');
  }
  tokenClient = oauth2.initTokenClient({
    client_id: readClientId(),
    scope: SCOPE,
    // callback is overridden per requestAccessToken so each call gets
    // a fresh promise. We supply a no-op here just to satisfy the API.
    callback: () => {
      /* set per-request */
    },
  });
  return tokenClient;
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.warn('[gis-token] listener threw:', e);
    }
  }
}

function classifyResponseError(response: TokenResponse): GisAuthError {
  const code = response.error;
  const message = response.error_description ?? response.error ?? 'Unknown GIS error';
  if (code === 'access_denied') return new GisAuthError('access-denied', message);
  if (code === 'interaction_required') return new GisAuthError('interaction-required', message);
  if (code === 'redirect_uri_mismatch') return new GisAuthError('redirect-uri-mismatch', message);
  return new GisAuthError('unknown', `${code ?? 'unknown'}: ${message}`);
}

function classifyClientError(error: TokenError): GisAuthError {
  const message = error.message ?? 'Unknown GIS client error';
  if (error.type === 'popup_closed') return new GisAuthError('popup-closed', message);
  if (error.type === 'popup_failed_to_open') return new GisAuthError('popup-blocked', message);
  return new GisAuthError('unknown', message);
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Subscribe to sign-in state changes. Fired when a token is minted
 * or revoked. Returns an unsubscribe function.
 */
export function subscribeAuthState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** True if a non-expired access token is cached in memory. */
export function isSignedIn(): boolean {
  if (readInjectedTestToken() !== null) return true;
  if (!cachedToken) return false;
  return cachedToken.expiresAt > Date.now() + TOKEN_LEEWAY_MS;
}

/**
 * Synchronous read of the cached access token. Returns `null` when
 * not signed in or when the cached token has expired. Use for code
 * paths that can't go async (registration sites, diagnostics tool
 * factories registered at submit time); React surfaces should prefer
 * `useAccessToken().resolveToken()` which handles silent reissue.
 */
export function readCachedTokenSync(): string | null {
  const injected = readInjectedTestToken();
  if (injected !== null) return injected;
  if (!isSignedIn()) return null;
  return cachedToken!.value;
}

/** Revoke and clear the cached token + profile + consent marker. */
export function signOut(): void {
  if (typeof window !== 'undefined' && cachedToken && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(cachedToken.value);
    } catch (e) {
      console.warn('[gis-token] revoke threw:', e);
    }
  }
  cachedToken = null;
  cachedUserInfo = null;
  clearConsentMarker();
  clearUserInfoStorage();
  notify();
}

/**
 * True if the user has previously completed a successful sign-in on
 * this origin (the marker is set by the success path of
 * `getAccessToken` and cleared by `signOut`). Callers can use this
 * to decide whether to attempt a silent reissue on app mount — GIS
 * silent reissue succeeds without UI when the user has prior consent
 * + an active Google session, so checking this flag avoids surprise
 * popups on first-visit pages.
 */
export function hasPriorConsent(): boolean {
  if (readInjectedTestToken() !== null) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CONSENTED_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The signed-in user's profile (email/name/picture) from Google's
 * userinfo endpoint. Returns `null` until the first sign-in completes;
 * persists across refresh via localStorage so the UI doesn't flicker
 * to "signed out" while silent reissue is in flight.
 */
export function getUserInfo(): GisUserInfo | null {
  return cachedUserInfo;
}

function setConsentMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONSENTED_STORAGE_KEY, String(Date.now()));
  } catch (e) {
    console.warn('[gis-token] consent marker write failed:', e);
  }
}

function clearConsentMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CONSENTED_STORAGE_KEY);
  } catch (e) {
    console.warn('[gis-token] consent marker clear failed:', e);
  }
}

function writeUserInfoStorage(info: GisUserInfo): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USERINFO_STORAGE_KEY, JSON.stringify(info));
  } catch (e) {
    console.warn('[gis-token] userinfo write failed:', e);
  }
}

function clearUserInfoStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(USERINFO_STORAGE_KEY);
  } catch (e) {
    console.warn('[gis-token] userinfo clear failed:', e);
  }
}

/**
 * Hit Google's userinfo endpoint to populate the profile cache.
 * Called after every successful token issue. Silent failure — if
 * userinfo's offline, we still have a usable access token; the UI
 * just won't display email/picture until the next successful fetch.
 */
async function refreshUserInfo(token: string): Promise<void> {
  try {
    const r = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      console.warn('[gis-token] userinfo fetch failed:', r.status);
      return;
    }
    const parsed = (await r.json()) as {
      sub: string;
      email?: string;
      name?: string;
      picture?: string;
    };
    cachedUserInfo = {
      sub: parsed.sub,
      email: parsed.email ?? '',
      name: parsed.name ?? '',
      picture: parsed.picture ?? '',
    };
    writeUserInfoStorage(cachedUserInfo);
    notify();
  } catch (e) {
    console.warn('[gis-token] userinfo fetch threw:', e);
  }
}

export interface GetAccessTokenOptions {
  /**
   * Force the consent popup even when a silent reissue would
   * succeed. Use for explicit "Sign in" button clicks; leave false
   * for `resolveToken`-style background calls.
   */
  forcePrompt?: boolean;
}

/**
 * Resolve a fresh access token. Returns the cached token when it's
 * still valid; otherwise calls GIS — silently if `forcePrompt` is
 * false (no UI when there's an active Google session), with the
 * consent popup if `forcePrompt` is true OR if silent reissue fails.
 *
 * Throws `GisAuthError` with a typed `code` on failure.
 */
export async function getAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
  const injected = readInjectedTestToken();
  if (injected !== null) return injected;
  if (!opts.forcePrompt && isSignedIn()) {
    return cachedToken!.value;
  }
  await loadGisScript();
  const client = getOrCreateTokenClient();

  return new Promise<string>((resolve, reject) => {
    client.callback = (response) => {
      if (response.error) {
        reject(classifyResponseError(response));
        return;
      }
      const token = response.access_token;
      if (!token) {
        reject(new GisAuthError('unknown', 'GIS returned no access_token'));
        return;
      }
      const grantedScopes = (response.scope ?? '').split(' ');
      if (!grantedScopes.includes(REQUIRED_API_SCOPE)) {
        reject(
          new GisAuthError(
            'scope-not-granted',
            `Required scope '${REQUIRED_API_SCOPE}' was not granted (got: '${response.scope ?? ''}')`,
          ),
        );
        return;
      }
      cachedToken = {
        value: token,
        scope: response.scope ?? SCOPE,
        expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
      };
      setConsentMarker();
      // Fire-and-forget userinfo fetch — populates the profile cache
      // so UI can render the signed-in user's email + name + picture.
      // Errors don't block sign-in; the access token is what callers
      // actually need.
      void refreshUserInfo(token);
      notify();
      resolve(token);
    };
    client.error_callback = (error) => {
      reject(classifyClientError(error));
    };
    try {
      client.requestAccessToken({ prompt: opts.forcePrompt ? 'consent' : '' });
    } catch (e) {
      reject(new GisAuthError('unknown', e instanceof Error ? e.message : String(e)));
    }
  });
}

/**
 * Run `fn` and, if it throws something matching `is401`, force a
 * token reissue + retry once. The retry path clears the cached
 * token first so the next `getAccessToken` call hits GIS for a
 * fresh issue. Callers that need 401 protection on multi-call
 * sequences (e.g. a Hosting deploy's createVersion → upload →
 * finalize chain) can wrap each request individually.
 */
export async function withTokenRetry<T>(
  fn: () => Promise<T>,
  is401: (e: unknown) => boolean,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!is401(e)) throw e;
    cachedToken = null;
    notify();
    // Silent reissue first; falls through to consent if the user's
    // Google session lapsed. Either way the retry uses the fresh token.
    await getAccessToken({ forcePrompt: false });
    return fn();
  }
}
