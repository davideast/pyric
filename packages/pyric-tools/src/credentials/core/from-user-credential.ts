/**
 * A logged-in user credential -> `ProjectScope` — the third credential source,
 * a sibling of `from-service-account`. `resolveToken` refreshes the access token
 * on demand (memoized by TTL); a revoked/expired refresh token surfaces as
 * `AuthExpired` (thrown from the exchange). Browser-safe.
 *
 * `projectId` is passed in (a user has many projects; the project comes from
 * `--project` / `.firebaserc` via `resolveScope`, not from the credential).
 */
import { memoizeTtl } from './memoize-ttl.js';
import type { ProjectScope, StoredCredential, OAuthClient } from './types.js';
import { exchangeRefreshToken } from './exchange.js';

export function fromUserCredential(
  cred: StoredCredential,
  client: OAuthClient,
  projectId: string,
): ProjectScope {
  const resolveToken = memoizeTtl(async () => {
    const { access_token, expires_in } = await exchangeRefreshToken(client, cred.refreshToken);
    return { token: access_token, expiresIn: expires_in };
  });
  return Object.freeze({ projectId, resolveToken });
}
