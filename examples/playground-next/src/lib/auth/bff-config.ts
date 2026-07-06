/**
 * BFF auth config (server-side). The browser can't do Google's code exchange
 * (the client_secret is required and Google has no public client type), so the
 * exchange + the refresh token live here, on the Astro server. Reuses
 * pyric-tools' isomorphic credential core.
 *
 * Activation is gated on `GIS_CLIENT_SECRET` (server-only env var, NOT PUBLIC_):
 * absent -> `bffClient()` returns null -> the endpoints 503 -> the browser falls
 * back to the existing GIS token client. Also register
 * `<origin>/api/auth/callback` as an authorized redirect URI on the OAuth client.
 */
import { oauthClient, type OAuthClient } from 'pyric-tools/credentials';

/** Same scopes the GIS client requested — the playground deploy needs cloud-platform. */
export const BFF_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
] as const;

export const COOKIE = {
  state: 'pyric_oauth_state',
  verifier: 'pyric_oauth_verifier',
  refresh: 'pyric_refresh',
} as const;

function readEnv(name: string): string | undefined {
  const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  return viteEnv?.[name] ?? (typeof process !== 'undefined' ? process.env?.[name] : undefined);
}

/** The configured BFF OAuth client, or null when the secret isn't set (BFF off). */
export function bffClient(): OAuthClient | null {
  const clientId = readEnv('PUBLIC_GIS_CLIENT_ID');
  const clientSecret = readEnv('GIS_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return oauthClient({ clientId, clientSecret });
}

export function callbackUri(origin: string): string {
  return `${origin}/api/auth/callback`;
}
