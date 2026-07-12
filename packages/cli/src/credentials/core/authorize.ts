/**
 * Authorization URL + PKCE + state. Pure / isomorphic: uses Web Crypto
 * (`crypto.getRandomValues` / `crypto.subtle`) and `btoa`, both present in modern
 * Node and browsers. No `node:*`.
 */
import type { OAuthClient } from './types.js';

/** base64url-encode bytes (btoa is isomorphic across Node 16+ and browsers). */
function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A random `state` nonce — the CSRF guard the authorizer validates on redirect. */
export function randomState(): string {
  return base64Url(randomBytes(16));
}

/** PKCE pair: a random verifier and its SHA-256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(randomBytes(32));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Build the Google consent URL. Pure. */
export function buildAuthUrl(params: {
  client: OAuthClient;
  scopes: readonly string[];
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: params.client.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scopes.join(' '),
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    access_type: 'offline', // required to receive a refresh token
    prompt: 'consent', // ensure a refresh token even on re-auth
    include_granted_scopes: 'true', // incremental: a later consent keeps prior grants
  });
  return `${params.client.authUri}?${q.toString()}`;
}
