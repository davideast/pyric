import { describe, it, expect, afterEach } from 'bun:test';
import { runLoginCommand, runLogoutCommand, runWhoamiCommand } from '../../src/cli/login.js';
import { resolveScope } from '../../src/cli/scope.js';
import { oauthClient } from '../../src/credentials/core/client.js';
import type { Authorizer, CredentialStore, StoredCredential } from '../../src/credentials/core/types.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function mockToken(body: unknown, status = 200) {
  // @ts-expect-error override global for the test
  globalThis.fetch = async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}
function memStore(init: StoredCredential | null = null) {
  const s = {
    c: init,
    read: async () => s.c,
    write: async (x: StoredCredential) => {
      s.c = x;
    },
    clear: async () => {
      s.c = null;
    },
  };
  return s satisfies CredentialStore & { c: StoredCredential | null };
}
const sink = () => {
  const lines: string[] = [];
  return { lines, write: (x: string) => void lines.push(x) };
};
const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;

describe('runLoginCommand', () => {
  it('signs in: exchanges, stores the refresh token, prints the email', async () => {
    const idToken = `h.${btoa(JSON.stringify({ email: 'u@x.com' }))}.s`;
    mockToken({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid email', id_token: idToken });
    const store = memStore();
    const out = sink();
    const authorizer: Authorizer = { authorize: async () => ({ code: 'C', redirectUri: 'http://127.0.0.1:9/' }) };
    const code = await runLoginCommand({ env: env({ PYRIC_OAUTH_CLIENT_ID: 'cid' }), store, authorizer, stdout: out, stderr: sink() });
    expect(code).toBe(0);
    expect(store.c?.refreshToken).toBe('RT');
    expect(out.lines.join('')).toContain('u@x.com');
  });

  it('errors when no OAuth client is configured', async () => {
    const err = sink();
    const code = await runLoginCommand({ env: env(), store: memStore(), stdout: sink(), stderr: err });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('OAuth client');
  });
});

describe('whoami / logout', () => {
  it('whoami: logged-out vs signed-in', async () => {
    const out1 = sink();
    await runWhoamiCommand({ store: memStore(), stdout: out1 });
    expect(out1.lines.join('')).toContain('Not signed in');

    const cred: StoredCredential = { version: 1, refreshToken: 'RT', scopes: ['firebase'], clientId: 'c', email: 'u@x.com', obtainedAt: 0 };
    const out2 = sink();
    await runWhoamiCommand({ store: memStore(cred), stdout: out2 });
    expect(out2.lines.join('')).toContain('u@x.com');
    expect(out2.lines.join('')).toContain('firebase');
  });

  it('logout clears the store', async () => {
    const store = memStore({ version: 1, refreshToken: 'RT', scopes: [], clientId: 'c', obtainedAt: 0 });
    await runLogoutCommand({ store, stdout: sink() });
    expect(store.c).toBeNull();
  });
});

describe('resolveScope sources + precedence', () => {
  const fakeSa = Buffer.from(
    JSON.stringify({ client_email: 'sa@x.iam', private_key: 'pk', project_id: 'sa-proj' }),
  ).toString('base64');
  const userCred: StoredCredential = { version: 1, refreshToken: 'RT', scopes: ['firebase', 'datastore'], clientId: 'c', obtainedAt: 0 };

  it('service-account env wins and grants all', async () => {
    const r = await resolveScope({ env: env({ FIREBASE_SA_BASE64: fakeSa }), store: memStore(userCred) });
    expect(r.source).toBe('FIREBASE_SA_BASE64');
    expect(r.grantedScopes).toBe('all');
    expect(r.scope.projectId).toBe('sa-proj');
  });

  it('logged-in user source carries the granted scopes; project from --project', async () => {
    const r = await resolveScope({ env: env(), projectId: 'my-proj', store: memStore(userCred), oauthClient: oauthClient({ clientId: 'c' }) });
    expect(r.source).toBe('login');
    expect(r.grantedScopes).toEqual(['firebase', 'datastore']);
    expect(r.scope.projectId).toBe('my-proj');
  });

  it('signed in but no project -> usage error', async () => {
    await expect(resolveScope({ env: env(), store: memStore(userCred) })).rejects.toThrow('project');
  });

  it('no credentials -> not authenticated', async () => {
    await expect(resolveScope({ env: env(), store: memStore(null) })).rejects.toThrow('not authenticated');
  });
});
