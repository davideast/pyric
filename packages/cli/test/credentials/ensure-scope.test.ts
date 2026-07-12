import { describe, it, expect, afterEach } from 'bun:test';
import { ensureScope } from '../../src/credentials/node/ensure-scope.js';
import { SCOPES } from '../../src/credentials/core/scopes.js';
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
const scope: ProjectScope = { projectId: 'demo', resolveToken: async () => 'tkn' };
const sink = () => {
  const lines: string[] = [];
  return { lines, write: (x: string) => void lines.push(x) };
};
const memStore = (): CredentialStore => {
  let c: StoredCredential | null = null;
  return { read: async () => c, write: async (x) => void (c = x), clear: async () => void (c = null) };
};
const base = (over: Record<string, unknown> = {}) => ({
  scope,
  target: 'storage',
  env: {} as NodeJS.ProcessEnv,
  out: sink(),
  err: sink(),
  ...over,
});

describe('ensureScope', () => {
  it("service account ('all') skips the upgrade", async () => {
    const r = await ensureScope(base({ requiredScope: SCOPES.cloudPlatform, grantedScopes: 'all', interactive: true }));
    expect(r).toEqual({ ok: true, scope, grantedScopes: 'all' });
  });

  it('already has the required scope -> no upgrade', async () => {
    const r = await ensureScope(base({ requiredScope: SCOPES.firebase, grantedScopes: [SCOPES.firebase], interactive: true }));
    expect(r.ok).toBe(true);
  });

  it('missing + non-interactive -> fail fast (exit 1) with guidance', async () => {
    const err = sink();
    const r = await ensureScope(base({ err, requiredScope: SCOPES.cloudPlatform, grantedScopes: [SCOPES.firebase], interactive: false }));
    expect(r).toEqual({ ok: false, exit: 1 });
    expect(err.lines.join('')).toContain('cloud-platform');
    expect(err.lines.join('')).toContain('pyric login');
  });

  it('missing + interactive -> re-authorizes and returns the upgraded grant', async () => {
    mockToken({ access_token: 'AT', refresh_token: 'RT2', expires_in: 3600, scope: `${SCOPES.firebase} ${SCOPES.cloudPlatform}` });
    const out = sink();
    const authorizer: Authorizer = { authorize: async () => ({ code: 'C', redirectUri: 'http://127.0.0.1:9/' }) };
    const r = await ensureScope(
      base({
        out,
        requiredScope: SCOPES.cloudPlatform,
        grantedScopes: [SCOPES.firebase],
        interactive: true,
        authorizer,
        store: memStore(),
        client: oauthClient({ clientId: 'c' }),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.grantedScopes).toEqual([SCOPES.firebase, SCOPES.cloudPlatform]);
      expect(r.scope.projectId).toBe('demo');
      expect(await r.scope.resolveToken()).toBe('AT'); // the upgraded scope resolves via the new refresh token
    }
    expect(out.lines.join('')).toContain('Re-authorizing');
  });
});
