/**
 * OAuth client config. `clientId`/`clientSecret` are INJECTED (the CLI reads them
 * from env / the baked default, the browser from its config) so the core stays
 * browser-safe — no `process.env` here.
 */
import type { OAuthClient } from './types.js';
import { BASE_SCOPES } from './scopes.js';

export const GOOGLE_AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export function oauthClient(opts: {
  clientId: string;
  clientSecret?: string;
  scopes?: readonly string[];
}): OAuthClient {
  return {
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    authUri: GOOGLE_AUTH_URI,
    tokenUri: GOOGLE_TOKEN_URI,
    baseScopes: [...(opts.scopes ?? BASE_SCOPES)],
  };
}
