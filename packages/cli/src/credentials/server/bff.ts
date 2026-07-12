/**
 * Backend-for-frontend (BFF) auth helpers — framework-agnostic. A browser can't
 * do the OAuth code exchange (Google requires the client_secret and has no public
 * client type) or hold a refresh token safely, so the exchange and the refresh
 * token live on a server. These functions are that server logic, taking and
 * returning plain values; the framework layer (e.g. Astro endpoints) wires them
 * to httpOnly cookies + responses. Reuses the isomorphic core verbatim.
 */
import type { OAuthClient } from '../core/types.js';
import { buildAuthUrl, pkce, randomState } from '../core/authorize.js';
import { exchangeAuthCode, exchangeRefreshToken, AuthExpired } from '../core/exchange.js';

export { AuthExpired };

/** Begin sign-in: the consent URL + the state/verifier to stash (as httpOnly
 *  cookies) for the callback to validate. */
export async function startAuth(opts: {
  client: OAuthClient;
  redirectUri: string;
  scopes: readonly string[];
}): Promise<{ authUrl: string; state: string; verifier: string }> {
  const { verifier, challenge } = await pkce();
  const state = randomState();
  const authUrl = buildAuthUrl({
    client: opts.client,
    scopes: opts.scopes,
    redirectUri: opts.redirectUri,
    challenge,
    state,
  });
  return { authUrl, state, verifier };
}

/** Complete sign-in: validate state, exchange the code server-side (with the
 *  secret), and return the refresh token to persist in an httpOnly cookie. */
export async function completeAuth(opts: {
  client: OAuthClient;
  code: string;
  returnedState: string;
  expectedState: string | undefined;
  verifier: string | undefined;
  redirectUri: string;
}): Promise<{ refreshToken: string }> {
  if (!opts.expectedState || opts.returnedState !== opts.expectedState) {
    throw new Error('bff: state mismatch (possible CSRF) — aborted');
  }
  if (!opts.verifier) throw new Error('bff: missing PKCE verifier');
  const tokens = await exchangeAuthCode({
    client: opts.client,
    code: opts.code,
    verifier: opts.verifier,
    redirectUri: opts.redirectUri,
  });
  if (!tokens.refresh_token) {
    throw new Error('bff: Google returned no refresh token (re-consent required)');
  }
  return { refreshToken: tokens.refresh_token };
}

/** Issue a fresh access token from the stored refresh token. Throws `AuthExpired`
 *  when the refresh token is revoked/expired so the caller can clear the cookie. */
export async function refreshAccess(opts: {
  client: OAuthClient;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const tokens = await exchangeRefreshToken(opts.client, opts.refreshToken);
  return { accessToken: tokens.access_token, expiresIn: tokens.expires_in };
}
