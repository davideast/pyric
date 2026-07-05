/**
 * `runLogin` — the env-agnostic login orchestrator. PKCE + state, hand the
 * authorizer a URL-builder (it owns its redirect), get the code, exchange it,
 * persist the GRANTED scopes. The authorizer + store are the only env-specific
 * bits; everything here is isomorphic. `now` is injectable for tests.
 */
import type { Authorizer, CredentialStore, OAuthClient, StoredCredential } from './types.js';
import { buildAuthUrl, pkce, randomState } from './authorize.js';
import { exchangeAuthCode } from './exchange.js';

export async function runLogin(opts: {
  authorizer: Authorizer;
  store: CredentialStore;
  client: OAuthClient;
  scopes: readonly string[];
  now?: () => number;
}): Promise<StoredCredential> {
  const { verifier, challenge } = await pkce();
  const state = randomState();
  const { code, redirectUri } = await opts.authorizer.authorize({
    buildUrl: (redirect) =>
      buildAuthUrl({ client: opts.client, scopes: opts.scopes, redirectUri: redirect, challenge, state }),
    state,
  });
  const tokens = await exchangeAuthCode({ client: opts.client, code, verifier, redirectUri });
  if (!tokens.refresh_token) {
    throw new Error('pyric login: Google returned no refresh token. Run `pyric logout` and try again.');
  }
  const cred: StoredCredential = {
    version: 1,
    refreshToken: tokens.refresh_token,
    // GRANTED scopes (from the response), not what we requested.
    scopes: (tokens.scope ?? opts.scopes.join(' ')).split(' ').filter(Boolean),
    clientId: opts.client.clientId,
    email: emailFromIdToken(tokens.id_token),
    obtainedAt: (opts.now ?? Date.now)(),
  };
  await opts.store.write(cred);
  return cred;
}

/** Best-effort email from the id_token payload (for `whoami`). Display-only — no
 *  signature verification needed; `atob` is isomorphic (Node 16+ and browsers). */
function emailFromIdToken(idToken?: string): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string };
    return claims.email;
  } catch {
    return undefined;
  }
}
