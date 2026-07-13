/**
 * Build a `ProjectScope` from a Google service
 * account JSON file. Exchanges the SA key for a short-lived OAuth
 * access token via the standard JWT-bearer flow, and wires
 * `memoizeTtl` internally so consumers get caching for free.
 *
 * No `firebase-admin` dependency — uses only Node's built-in
 * `crypto` for RS256 signing and `fetch` for the token exchange.
 *
 * **Node-only credential adapter**: the function itself
 * requires `node:fs/promises` + `node:crypto`. Those modules are
 * imported via dynamic `import()` inside the function body so the
 * `@pyric/cli/credentials` entry stays browser-bundle safe.
 */

import { memoizeTtl } from '../core/memoize-ttl.js';
import type { ProjectScope } from '../core/types.js';

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = [
  // Project verification and inspection use Firebase and Google Cloud APIs.
  'https://www.googleapis.com/auth/firebase',
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Read the service account from a JSON file and return a
 * `ProjectScope` whose `resolveToken` is memoized internally.
 *
 * The JSON file path can be:
 * - An absolute / relative filesystem path (Node only).
 * - A base64-encoded JSON string (when prefixed with `base64:`),
 *   for environments that ship the SA in an env var.
 */
export async function fromServiceAccount(
  saJsonOrPath: string,
): Promise<ProjectScope> {
  const sa = await loadServiceAccount(saJsonOrPath);
  const resolveToken = memoizeTtl(async () => {
    const { access_token, expires_in } = await exchangeJwtForAccessToken(sa);
    return { token: access_token, expiresIn: expires_in };
  });
  // Freeze the returned scope so `projectId` can't be mutated at
  // runtime. TS `readonly` is compile-time-only; Object.freeze
  // enforces it at runtime — defense in depth for the
  // security-relevant identity field.
  return Object.freeze({
    projectId: sa.project_id,
    resolveToken,
  });
}

async function loadServiceAccount(saJsonOrPath: string): Promise<ServiceAccount> {
  let raw: string;
  if (saJsonOrPath.startsWith('base64:')) {
    raw = Buffer.from(saJsonOrPath.slice('base64:'.length), 'base64').toString('utf-8');
  } else if (saJsonOrPath.trim().startsWith('{')) {
    raw = saJsonOrPath;
  } else {
    // Dynamic import keeps `node:fs/promises` out of browser bundles
    // when this function isn't called.
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(saJsonOrPath, 'utf-8');
  }
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error(
      'fromServiceAccount: input is missing required fields (client_email, private_key, project_id)',
    );
  }
  return parsed as ServiceAccount;
}

async function exchangeJwtForAccessToken(sa: ServiceAccount): Promise<TokenResponse> {
  const jwt = await buildSignedJwt(sa);
  const res = await fetch(sa.token_uri ?? GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `fromServiceAccount: token exchange failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

async function buildSignedJwt(sa: ServiceAccount): Promise<string> {
  // Dynamic import keeps `node:crypto` out of browser bundles when
  // `fromServiceAccount` is never called.
  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri ?? GOOGLE_TOKEN_URI,
    exp: now + 3600,
    iat: now,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const signatureB64 = base64UrlEncodeBuffer(signature);
  return `${signingInput}.${signatureB64}`;
}

function base64UrlEncode(s: string): string {
  return base64UrlEncodeBuffer(Buffer.from(s, 'utf-8'));
}

function base64UrlEncodeBuffer(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
