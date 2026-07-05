/**
 * Token exchange against Google's token endpoint — `fetch` only (the same seam
 * `from-service-account` uses; tested via a global-`fetch` mock). Shared by login
 * (auth-code grant) and the user source (refresh grant).
 */
import type { OAuthClient, TokenResponse } from './types.js';

/**
 * Thrown when a refresh token is rejected (revoked, or expired — e.g. the
 * Testing-mode 7-day expiry). The CLI maps this to "run `pyric login`" rather
 * than surfacing a raw token-endpoint error mid-deploy.
 */
export class AuthExpired extends Error {
  constructor(message = 'Your pyric login has expired or was revoked. Run `pyric login`.') {
    super(message);
    this.name = 'AuthExpired';
  }
}

async function tokenRequest(client: OAuthClient, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes('invalid_grant')) throw new AuthExpired();
    throw new Error(`pyric login: token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Auth-code grant (login). */
export function exchangeAuthCode(params: {
  client: OAuthClient;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  return tokenRequest(params.client, {
    client_id: params.client.clientId,
    ...(params.client.clientSecret ? { client_secret: params.client.clientSecret } : {}),
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  });
}

/** Refresh grant (the user source's `resolveToken`). */
export function exchangeRefreshToken(client: OAuthClient, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(client, {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}
