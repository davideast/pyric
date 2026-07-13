/**
 * Smoke tests for `createStorageAdminTools` — verify the factory's
 * surface, that handlers dispatch through `createDispatch(registry)`,
 * and that the `ProjectScope` token resolver is threaded into the
 * underlying fetch calls. `fetch` is stubbed; no live API usage.
 */
import { afterEach, describe, it, expect } from 'bun:test';
import { createToolRegistry, createDispatch } from '@inbrowser/agent';
import type { ProjectScope } from '../../../src/project-scope.js';
import { createStorageAdminTools } from '../../../src/storage/admin/tools.js';

const fakeCtx = { signal: new AbortController().signal };

const scope: ProjectScope = {
  projectId: 'p',
  resolveToken: async () => 'tkn',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a scripted url→response map; records calls. */
function stub(routes: Array<{ match: string; status: number; body?: unknown }>): {
  calls: string[];
} {
  const calls: string[] = [];
  // @ts-expect-error — overriding global for the test.
  globalThis.fetch = async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? 404;
    const body = route?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls };
}

describe('createStorageAdminTools', () => {
  it('emits the two control-plane tool names', () => {
    const tools = createStorageAdminTools({ scope });
    expect(tools.map((t) => t.name)).toEqual([
      'storage_get_status',
      'storage_provision',
    ]);
  });

  it('storage_get_status reports service state + buckets', async () => {
    stub([
      { match: 'serviceusage.googleapis.com', status: 200, body: { state: 'ENABLED' } },
      { match: 'firebase.googleapis.com', status: 200, body: { resources: { locationId: 'us-central' } } },
      {
        match: 'firebasestorage.googleapis.com',
        status: 200,
        body: { buckets: [{ name: 'projects/p/buckets/p.firebasestorage.app' }] },
      },
    ]);

    const registry = createToolRegistry();
    for (const t of createStorageAdminTools({ scope })) registry.register(t);
    const dispatch = createDispatch(registry);

    const result = await dispatch.execute(
      { id: '1', name: 'storage_get_status', args: {} },
      fakeCtx,
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      serviceState: string;
      defaultLocation: string | null;
      buckets: Array<{ bucketId: string }>;
    };
    expect(data.serviceState).toBe('enabled');
    expect(data.defaultLocation).toBe('us-central');
    expect(data.buckets).toEqual([{ name: 'projects/p/buckets/p.firebasestorage.app', bucketId: 'p.firebasestorage.app' }]);
  });

  it('storage_provision surfaces PERMISSION_DENIED via ok:false', async () => {
    // Service disabled → enable attempt → 403 with the serviceusage reason.
    stub([
      { match: 'services/firebasestorage.googleapis.com:enable', status: 403, body: { error: { message: 'caller lacks serviceusage.services.enable', details: [{ reason: 'AUTH_PERMISSION_DENIED' }] } } },
      { match: 'services/firebasestorage.googleapis.com', status: 200, body: { state: 'DISABLED' } },
    ]);

    const registry = createToolRegistry();
    for (const t of createStorageAdminTools({ scope })) registry.register(t);
    const dispatch = createDispatch(registry);

    const result = await dispatch.execute(
      { id: '1', name: 'storage_provision', args: {} },
      fakeCtx,
    );
    expect(result.ok).toBe(false);
    const data = result.data as { success: false; error: { code: string } };
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('PERMISSION_DENIED');
  });

  it('maps an API-disabled getProject 403 to SERVICE_DISABLED (not UNKNOWN)', async () => {
    // Storage service enabled, but the Firebase Management API is off — getProject
    // 403s with the prose "has not been used ... or it is disabled" form (no
    // `reason` field). mapError must classify it recoverable, not UNKNOWN. (The
    // deploy preflight enables it up front in production; this pins the mapping.)
    stub([
      { match: 'services/firebasestorage.googleapis.com', status: 200, body: { state: 'ENABLED' } },
      {
        match: 'firebase.googleapis.com/',
        status: 403,
        body: {
          error: {
            message:
              'Firebase Management API has not been used in project 123 before or it is disabled.',
          },
        },
      },
    ]);

    const registry = createToolRegistry();
    for (const t of createStorageAdminTools({ scope })) registry.register(t);
    const dispatch = createDispatch(registry);

    const result = await dispatch.execute(
      { id: '1', name: 'storage_provision', args: {} },
      fakeCtx,
    );
    expect(result.ok).toBe(false);
    const data = result.data as { success: false; error: { code: string } };
    expect(data.error.code).toBe('SERVICE_DISABLED');
  });

  it('threads the ProjectScope token resolver into the fetch Authorization header', async () => {
    let seenAuth: string | undefined;
    // @ts-expect-error — overriding global for the test.
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({ state: 'DISABLED' }),
        text: async () => '{}',
      };
    };

    const customScope: ProjectScope = {
      projectId: 'p',
      resolveToken: async () => 'resolved-token-xyz',
    };
    const registry = createToolRegistry();
    for (const t of createStorageAdminTools({ scope: customScope })) registry.register(t);
    const dispatch = createDispatch(registry);

    await dispatch.execute(
      { id: '1', name: 'storage_get_status', args: {} },
      fakeCtx,
    );
    expect(seenAuth).toBe('Bearer resolved-token-xyz');
  });
});
