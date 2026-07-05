import { describe, it, expect, afterEach } from 'bun:test';
import { startAuth, completeAuth, refreshAccess, AuthExpired } from '../../src/credentials/server/bff.js';
import { oauthClient } from '../../src/credentials/core/client.js';

const client = oauthClient({ clientId: 'c', clientSecret: 's' });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function mockToken(body: unknown, status = 200) {
  // @ts-expect-error override global for the test
  globalThis.fetch = async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('bff.startAuth', () => {
  it('returns a consent URL (offline access) + state + verifier', async () => {
    const r = await startAuth({
      client,
      redirectUri: 'https://app/api/auth/callback',
      scopes: ['openid', 'https://www.googleapis.com/auth/cloud-platform'],
    });
    const url = new URL(r.authUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/api/auth/callback');
    expect(url.searchParams.get('state')).toBe(r.state);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(r.verifier.length).toBeGreaterThan(20);
  });
});

describe('bff.completeAuth', () => {
  it('validates state, exchanges, returns the refresh token', async () => {
    mockToken({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid' });
    const r = await completeAuth({ client, code: 'C', returnedState: 'ST', expectedState: 'ST', verifier: 'V', redirectUri: 'https://app/cb' });
    expect(r.refreshToken).toBe('RT');
  });
  it('rejects on state mismatch (CSRF guard)', async () => {
    await expect(
      completeAuth({ client, code: 'C', returnedState: 'X', expectedState: 'ST', verifier: 'V', redirectUri: 'r' }),
    ).rejects.toThrow('state mismatch');
  });
  it('rejects when Google returns no refresh token', async () => {
    mockToken({ access_token: 'AT', expires_in: 3600 });
    await expect(
      completeAuth({ client, code: 'C', returnedState: 'ST', expectedState: 'ST', verifier: 'V', redirectUri: 'r' }),
    ).rejects.toThrow('refresh token');
  });
});

describe('bff.refreshAccess', () => {
  it('returns a fresh access token', async () => {
    mockToken({ access_token: 'AT2', expires_in: 3600 });
    expect((await refreshAccess({ client, refreshToken: 'RT' })).accessToken).toBe('AT2');
  });
  it('maps invalid_grant to AuthExpired', async () => {
    mockToken('{"error":"invalid_grant"}', 400);
    await expect(refreshAccess({ client, refreshToken: 'RT' })).rejects.toBeInstanceOf(AuthExpired);
  });
});
