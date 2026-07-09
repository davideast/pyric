/**
 * OpenRouter "Sign in with OpenRouter" — client-side OAuth (PKCE) via
 * `@inbrowser/model`'s `beginOpenRouterOAuth` / `completeOpenRouterOAuth`.
 * Lets the user provision an OpenRouter key without pasting one, on a
 * STATIC build (no server routes) — the whole exchange runs page-side.
 *
 * Flow (full-page redirect; there is no popup here — a popup would need
 * a same-origin postMessage relay this static site doesn't have):
 *
 *   1. `beginSignIn()` — mint a PKCE verifier + challenge, stash the
 *      verifier in `sessionStorage` (must survive the redirect; a
 *      full-page navigation clears in-memory state), then
 *      `window.location.assign(authUrl)`.
 *   2. OpenRouter redirects back to THIS page with `?code=...`.
 *      `completeSignInIfPending()` runs once on load: detects the
 *      `code` param, reads the stashed verifier, exchanges them for a
 *      key, stores the key through the existing BYOK slot (session
 *      backend — see `byok.ts`), clears the verifier, and cleans the
 *      `code` param off the URL via `history.replaceState` so a reload
 *      doesn't re-run the exchange (OpenRouter codes are single-use;
 *      retrying would fail and could loop).
 *
 * The pure pieces (callback detection, URL cleaning, verifier stash
 * lifecycle) are unit tested in `openrouter-oauth.test.ts`. The actual
 * redirect round trip through OpenRouter's authorize page is NOT
 * exercised by any test here — it needs a human to click through it in
 * a real browser. See AGENTS.md / the PR description for the manual
 * check.
 */
import {
  beginOpenRouterOAuth,
  completeOpenRouterOAuth,
} from '@inbrowser/model';
import { openrouterByok } from './byok';

const VERIFIER_KEY = 'pyric.playground.oauth.openrouter.verifier';
const CODE_PARAM = 'code';

// ── Pure helpers ────────────────────────────────────────────────────

/**
 * Does `url` carry an OpenRouter OAuth callback (`?code=...`)? Returns
 * the code, or null when this isn't a callback load. Pulled out of
 * `completeSignInIfPending` so it's testable without touching
 * `sessionStorage` or the network.
 */
export function detectOAuthCode(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const code = parsed.searchParams.get(CODE_PARAM);
  return code && code.length > 0 ? code : null;
}

/**
 * Strip the OAuth `code` query param from `url`, returning the cleaned
 * URL string. Used with `history.replaceState` so the code — single-use
 * and otherwise re-submitted on every reload — doesn't linger in the
 * address bar. Leaves every other query param and the hash untouched.
 */
export function cleanOAuthUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(CODE_PARAM);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Persist the PKCE verifier across the redirect. */
export function stashCodeVerifier(verifier: string): void {
  safeSessionStorage()?.setItem(VERIFIER_KEY, verifier);
}

/** Read the stashed verifier, or null if none is pending. */
export function readCodeVerifier(): string | null {
  return safeSessionStorage()?.getItem(VERIFIER_KEY) ?? null;
}

/** Drop the stashed verifier — called once the exchange has been
 *  attempted (success or failure), so a stale verifier can't be reused
 *  or mistaken for a still-pending flow. */
export function clearCodeVerifier(): void {
  safeSessionStorage()?.removeItem(VERIFIER_KEY);
}

// ── Orchestration (needs a browser + network; not unit tested) ──────

/** Where OpenRouter should send the user back. The current page,
 *  stripped of any prior `code` — OpenRouter constrains this to https
 *  on port 443/3000, or localhost on any port, which every supported
 *  deploy target (prod, preview, local dev) satisfies. */
function callbackUrl(): string {
  return `${window.location.origin}${cleanOAuthUrl(window.location.href)}`;
}

/**
 * Kick off the OAuth flow: mint a verifier, stash it, and redirect the
 * whole page to OpenRouter's authorize screen. Never returns (the
 * navigation replaces the page) — callers should not expect code after
 * this to run in the same page lifecycle.
 */
export async function beginSignIn(): Promise<void> {
  const { authUrl, codeVerifier } = await beginOpenRouterOAuth({
    callbackUrl: callbackUrl(),
  });
  stashCodeVerifier(codeVerifier);
  window.location.assign(authUrl);
}

export type CompleteSignInResult =
  | { status: 'not-pending' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/**
 * Call once on page load. If the URL carries a pending OAuth callback,
 * completes the exchange and stores the key via `openrouterByok`
 * (session backend — see `byok.ts`'s storage policy). Always cleans the
 * `code` param off the URL when one was present, success or failure, so
 * a refresh can't re-submit an already-used code and loop.
 */
export async function completeSignInIfPending(): Promise<CompleteSignInResult> {
  const code = detectOAuthCode(window.location.href);
  if (!code) return { status: 'not-pending' };

  const cleaned = cleanOAuthUrl(window.location.href);
  // Clean the URL first — whatever happens below, we never want a
  // reload to resubmit this code.
  window.history.replaceState(null, '', cleaned);

  const codeVerifier = readCodeVerifier();
  clearCodeVerifier();
  if (!codeVerifier) {
    return {
      status: 'error',
      message:
        'Sign-in could not be completed — the verification token was lost (e.g. the tab was closed mid-flow). Try signing in again.',
    };
  }

  try {
    const { key } = await completeOpenRouterOAuth({ code, codeVerifier });
    // OAuth-provisioned keys default to sessionStorage — the owner's
    // storage policy for keys the user didn't type themselves. The key
    // UI offers "remember on this device" to promote to localStorage.
    openrouterByok.setKey(key, { backend: 'session' });
    return { status: 'success' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'OpenRouter sign-in failed.';
    return { status: 'error', message };
  }
}
