/**
 * Smoke tests for the `hosting` and `functions` namespace wrappers
 * (L14). Confirms they:
 *
 *   - Call `scope.resolveToken()` per dispatch (F4).
 *   - Pass `scope.projectId` through to the portable cores.
 *   - Forward the rest of the input shape unchanged.
 *
 * Doesn't cover the portable cores themselves — those have their
 * own test files. Just the thin wrapping layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { hosting, functions, type ProjectScope } from '../../src/deploy/index.js';

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

interface FetchCall { url: string; init: RequestInit | undefined }

function installFetchMock(responses: Response[]): { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Fetch mock ran out of queued responses (called ${url})`);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const makeScope = (token = 'TKN'): ProjectScope => ({
  projectId: 'p',
  resolveToken: async () => token,
});

describe('hosting.sites.create (L14 smoke)', () => {
  it('threads scope.projectId + Authorization Bearer per dispatch', async () => {
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'projects/p/sites/my-site' }),
    ]);
    const result = await hosting.sites.create(makeScope('TKN-1'), { siteId: 'my-site' });
    expect(result.kind).toBe('ok');
    expect(calls[0].url).toContain('/projects/p/sites?siteId=my-site');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer TKN-1');
  });
});

describe('hosting.sites.ensure (L14 smoke)', () => {
  it('maps 409 from create → ensure existed branch', async () => {
    installFetchMock([new Response('exists', { status: 409 })]);
    const result = await hosting.sites.ensure(makeScope(), { siteId: 'my-site' });
    expect(result.kind).toBe('existed');
  });
});

describe('hosting.deployFiles (L14 smoke)', () => {
  it('rejects when neither files nor localDir is supplied', async () => {
    installFetchMock([]);
    await expect(hosting.deployFiles(makeScope(), { siteId: 'p' })).rejects.toThrow(
      /must supply either/,
    );
  });
});

describe('functions.deployLocal (L14 smoke)', () => {
  it('rejects empty localDir at the boundary', async () => {
    const result = await functions.deployLocal(makeScope(), {
      localDir: '',
      functions: [{ id: 'f', entryPoint: 'f' }] as unknown as never,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty functions array', async () => {
    const result = await functions.deployLocal(makeScope(), {
      localDir: '/nonexistent',
      functions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('functions.grantPublicInvoker (L14 smoke)', () => {
  it('passes scope.projectId + Bearer token through', async () => {
    const { calls } = installFetchMock([jsonResponse(200, {})]);
    await functions.grantPublicInvoker(makeScope('TKN-x'), {
      region: 'us-central1',
      serviceId: 'svc-abc',
    });
    expect(calls[0].url).toContain('/projects/p/locations/us-central1/services/svc-abc:setIamPolicy');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer TKN-x');
  });
});
