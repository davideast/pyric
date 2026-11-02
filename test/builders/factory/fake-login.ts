/**
 * A made-up Codex login for the factory's tests: JWT-shaped tokens with an
 * `exp`, and no real value anywhere.
 */
import type { CodexLogin } from './codex-login.ts';

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A JWT-shaped made-up token that lapses at `expiresAt`. */
export function fakeJwt(name: string, expiresAt: Date): string {
  return `${base64url({ alg: 'none' })}.${base64url({ exp: Math.floor(expiresAt.getTime() / 1000), sub: name })}.made-up-signature-${name}`;
}

export const FAKE_ACCOUNT = 'made-up-account-id';

export interface FakeAuth {
  json: string;
  access: string;
  refresh: string;
  id: string;
}

/** An auth.json in Codex's shape, with made-up tokens. */
export function fakeAuth(expiresAt: Date = new Date(Date.now() + 86_400_000)): FakeAuth {
  const access = fakeJwt('access', expiresAt);
  const refresh = 'made-up-refresh-token';
  const id = fakeJwt('id', expiresAt);
  const json = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: id, access_token: access, refresh_token: refresh, account_id: FAKE_ACCOUNT }, last_refresh: new Date().toISOString() });
  return { json, access, refresh, id };
}

export function fakeLogin(expiresAt: Date = new Date(Date.now() + 86_400_000)): CodexLogin {
  const auth = fakeAuth(expiresAt);
  return { accessToken: auth.access, accountId: FAKE_ACCOUNT, secrets: [auth.access, auth.refresh, auth.id], expiresAt };
}
