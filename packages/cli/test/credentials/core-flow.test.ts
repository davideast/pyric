import { describe, it, expect, afterEach } from 'bun:test';
import { oauthClient } from '../../src/credentials/core/client.js';
import { SCOPES } from '../../src/credentials/core/scopes.js';
import { exchangeRefreshToken, AuthExpired } from '../../src/credentials/core/exchange.js';
import { fromUserCredential } from '../../src/credentials/core/from-user-credential.js';
import { runLogin } from '../../src/credentials/core/flow.js';
import type { Authorizer, CredentialStore, StoredCredential } from '../../src/credentials/core/types.js';

const client = oauthClient({ clientId: 'c', clientSecret: 's' });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockToken(resp: { status: number; body: unknown }) {
  // @ts-expect-error override global for the test
  globalThis.fetch = async () =>
    new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), { status: resp.status });
}

const memStore = (): CredentialStore & { written: StoredCredential | null } => {
  const s = {
    written: null as StoredCredential | null,
    read: async () => s.written,
    write: async (c: StoredCredential) => {
      s.written = c;
    },
    clear: async () => {
      s.written = null;
    },
  };
  return s;
};

describe('exchange', () => {
  it('refresh grant returns the access token', async () => {
    mockToken({ status: 200, body: { access_token: 'AT', expires_in: 3600 } });
    expect((await exchangeRefreshToken(client, 'RT')).access_token).toBe('AT');
  });
  it('invalid_grant -> AuthExpired', async () => {
    mockToken({ status: 400, body: '{"error":"invalid_grant"}' });
    await expect(exchangeRefreshToken(client, 'RT')).rejects.toBeInstanceOf(AuthExpired);
  });
});

describe('fromUserCredential', () => {
  it('resolveToken refreshes; projectId is the one passed in', async () => {
    mockToken({ status: 200, body: { access_token: 'AT2', expires_in: 3600 } });
    const cred: StoredCredential = { version: 1, refreshToken: 'RT', scopes: ['x'], clientId: 'c', obtainedAt: 0 };
    const scope = fromUserCredential(cred, client, 'my-project');
    expect(scope.projectId).toBe('my-project');
    expect(await scope.resolveToken()).toBe('AT2');
  });
});

describe('runLogin', () => {
  it('stores the GRANTED scopes (not requested) + the refresh token', async () => {
    // Requested firebase+datastore; Google grants only firebase (user unchecked datastore).
    mockToken({
      status: 200,
      body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: `openid ${SCOPES.firebase}` },
    });
    const store = memStore();
    let urlSeen = '';
    const authorizer: Authorizer = {
      authorize: async (req) => {
        urlSeen = req.buildUrl('http://localhost:9099/cb');
        return { code: 'CODE', redirectUri: 'http://localhost:9099/cb' };
      },
    };
    const cred = await runLogin({
      authorizer,
      store,
      client,
      scopes: ['openid', SCOPES.firebase, SCOPES.datastore],
      now: () => 123,
    });
    expect(cred.refreshToken).toBe('RT');
    expect(cred.scopes).toEqual(['openid', SCOPES.firebase]); // GRANTED, datastore absent
    expect(cred.obtainedAt).toBe(123);
    expect(store.written).toEqual(cred);
    expect(urlSeen).toContain('code_challenge='); // the authorizer received a real auth URL
  });

  it('errors when Google returns no refresh token', async () => {
    mockToken({ status: 200, body: { access_token: 'AT', expires_in: 3600 } });
    const authorizer: Authorizer = { authorize: async () => ({ code: 'C', redirectUri: 'r' }) };
    await expect(runLogin({ authorizer, store: memStore(), client, scopes: ['openid'] })).rejects.toThrow('refresh token');
  });
});
