/**
 * Service-account access for the oracle captures: an OAuth access token minted
 * with node:crypto and fetch, and the Realtime Database rules endpoint those
 * tokens authorize.
 */
import { createSign } from 'node:crypto';

/** The fields of a service-account key the token exchange reads. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** The scopes the Realtime Database rules endpoint requires. */
export const RTDB_RULES_SCOPE =
  'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

/** Mint a one-hour OAuth access token for `scope` from a service-account key. */
export async function mintAccessToken(sa: ServiceAccountKey, scope: string): Promise<string> {
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key).toString('base64url');
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** The Realtime Database rules endpoint, `/.settings/rules.json`. */
export interface RtdbRulesEndpoint {
  /** The active rules source, as text. */
  read(): Promise<string>;
  /**
   * `PUT /.settings/rules.json?dryRun=true`, the validation request
   * `firebase deploy` makes: production compiles and type-checks the ruleset
   * and installs nothing. Status 200 accepts; status 400 refuses with the body.
   */
  dryRun(rules: { rules: Record<string, unknown> }): Promise<{ status: number; body: string }>;
}

export function rtdbRulesEndpoint(databaseURL: string, accessToken: string): RtdbRulesEndpoint {
  const url = `${databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(accessToken)}`;
  return {
    async read() {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`read rules failed: ${response.status}`);
      return response.text();
    },
    async dryRun(rules) {
      const response = await fetch(`${url}&dryRun=true`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rules),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}
