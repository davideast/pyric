import { describe, it, expect, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { fromAdc } from '../../src/credentials/node/from-adc.js';
import { resolveScope } from '../../src/cli/scope.js';
import { runLoginCommand } from '../../src/cli/login.js';
import { oauthClient } from '../../src/credentials/core/client.js';
import type { Authorizer, CredentialStore, ProjectScope, StoredCredential } from '../../src/credentials/core/types.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function mockToken(body: unknown, status = 200) {
  // @ts-expect-error override global for the test
  globalThis.fetch = async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}
const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;
const tmpPath = () => join(tmpdir(), `pyric-adc-${Math.random().toString(36).slice(2)}.json`);
function memStore(init: StoredCredential | null = null) {
  const s = {
    c: init,
    read: async () => s.c,
    write: async (x: StoredCredential) => void (s.c = x),
    clear: async () => void (s.c = null),
  };
  return s satisfies CredentialStore & { c: StoredCredential | null };
}
const sink = () => {
  const lines: string[] = [];
  return { lines, write: (x: string) => void lines.push(x) };
};

describe('fromAdc', () => {
  it('authorized_user -> a ProjectScope that refreshes', async () => {
    const p = tmpPath();
    await writeFile(p, JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'sec', refresh_token: 'RT' }));
    mockToken({ access_token: 'ADC_AT', expires_in: 3600 });
    const scope = await fromAdc('proj', env(), p);
    expect(scope?.projectId).toBe('proj');
    expect(await scope?.resolveToken()).toBe('ADC_AT');
    await rm(p);
  });
  it('missing file -> null', async () => {
    expect(await fromAdc('proj', env(), tmpPath())).toBeNull();
  });
  it('service_account ADC -> delegates, with the project override applied', async () => {
    const p = tmpPath();
    await writeFile(p, JSON.stringify({ type: 'service_account', client_email: 'sa@x.iam', private_key: 'pk', project_id: 'sa-proj' }));
    const scope = await fromAdc('override-proj', env(), p);
    expect(scope?.projectId).toBe('override-proj');
    await rm(p);
  });
  it('unknown type -> null', async () => {
    const p = tmpPath();
    await writeFile(p, JSON.stringify({ type: 'external_account' }));
    expect(await fromAdc('proj', env(), p)).toBeNull();
    await rm(p);
  });
});

describe('resolveScope non-interactive sources', () => {
  const client = oauthClient({ clientId: 'c' });
  it('PYRIC_REFRESH_TOKEN -> source token, grants all, scoped to --project', async () => {
    const r = await resolveScope({ env: env({ PYRIC_REFRESH_TOKEN: 'RT' }), projectId: 'p', oauthClient: client, store: memStore(null) });
    expect(r.source).toBe('PYRIC_REFRESH_TOKEN');
    expect(r.grantedScopes).toBe('all');
    expect(r.scope.projectId).toBe('p');
  });
  it('CI token without a project -> usage error', async () => {
    await expect(resolveScope({ env: env({ PYRIC_REFRESH_TOKEN: 'RT' }), store: memStore(null) })).rejects.toThrow('project');
  });
  it('CI token wins over a stored login (precedence)', async () => {
    const stored: StoredCredential = { version: 1, refreshToken: 'stored', scopes: ['firebase'], clientId: 'c', obtainedAt: 0 };
    const r = await resolveScope({ env: env({ PYRIC_REFRESH_TOKEN: 'RT' }), projectId: 'p', oauthClient: client, store: memStore(stored) });
    expect(r.source).toBe('PYRIC_REFRESH_TOKEN');
  });
  it('ADC is the last fallback (no other source)', async () => {
    const adcScope: ProjectScope = { projectId: 'p', resolveToken: async () => 'adc-tkn' };
    const r = await resolveScope({ env: env(), projectId: 'p', store: memStore(null), adc: async () => adcScope });
    expect(r.source).toBe('adc');
    expect(r.grantedScopes).toBe('all');
    expect(r.scope).toBe(adcScope);
  });
  it('no source + no ADC -> not authenticated', async () => {
    await expect(resolveScope({ env: env(), projectId: 'p', store: memStore(null), adc: async () => null })).rejects.toThrow(
      'not authenticated',
    );
  });
});

describe('login --ci', () => {
  it('prints the refresh token on stdout + the env-var hint on stderr', async () => {
    mockToken({ access_token: 'AT', refresh_token: 'CI_RT', expires_in: 3600, scope: 'openid' });
    const out = sink();
    const err = sink();
    const authorizer: Authorizer = { authorize: async () => ({ code: 'C', redirectUri: 'http://127.0.0.1:9/' }) };
    const code = await runLoginCommand({ env: env({ PYRIC_OAUTH_CLIENT_ID: 'cid' }), store: memStore(), authorizer, stdout: out, stderr: err, ci: true });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('CI_RT');
    expect(err.lines.join('')).toContain('PYRIC_REFRESH_TOKEN');
  });
});
