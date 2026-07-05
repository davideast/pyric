import { describe, test, expect, afterEach } from 'bun:test';
import { fetchDatabase, type RtdbHost } from '../../src/database/host.js';

function makeHost(overrides: Partial<RtdbHost> = {}): RtdbHost {
  return {
    projectId: 'my-project',
    databaseUrl: 'https://my-project-default-rtdb.firebaseio.com',
    resolveAdminToken: async () => 'admin-token',
    resolveUserToken: async () => 'user-token',
    getClientForUser: async () => { throw new Error('not implemented'); },
    ...overrides,
  };
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function captureFetch(): () => Captured {
  const captured: Captured = { url: '', init: undefined };
  (global as { fetch: typeof fetch }).fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.url = url.toString();
    captured.init = init;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return () => captured;
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization;
}

describe('fetchDatabase', () => {
  test('sends admin token as a Bearer header, never in the URL', async () => {
    const cap = captureFetch();
    await fetchDatabase(makeHost(), '/.json');
    const { url, init } = cap();
    expect(authHeader(init)).toBe('Bearer admin-token');
    expect(url).not.toContain('admin-token');
    expect(url).not.toContain('access_token');
    expect(url).not.toContain('auth=');
  });

  test('uses auth=… when userToken supplied (admin token NOT requested)', async () => {
    const cap = captureFetch();
    let adminCalls = 0;
    await fetchDatabase(
      makeHost({ resolveAdminToken: async () => { adminCalls++; return 'admin-token'; } }),
      '/.json',
      { shallow: 'true' },
      'user-id-token',
    );
    const { url, init } = cap();
    expect(url).toContain('auth=user-id-token');
    expect(url).not.toContain('access_token');
    expect(authHeader(init)).toBeUndefined();
    expect(url).toContain('shallow=true');
    expect(adminCalls).toBe(0);
  });

  test('preserves host.databaseUrl origin + path', async () => {
    const cap = captureFetch();
    await fetchDatabase(
      makeHost({ databaseUrl: 'https://custom-db.firebaseio.com' }),
      '/.settings/rules.json',
    );
    const { url } = cap();
    expect(url).toContain('https://custom-db.firebaseio.com');
    expect(url).toContain('/.settings/rules.json');
  });

  test('passes extra params through the URL', async () => {
    const cap = captureFetch();
    await fetchDatabase(makeHost(), '/.json', { shallow: 'true' });
    expect(cap().url).toContain('shallow=true');
  });

  test('refuses to follow redirects', async () => {
    const cap = captureFetch();
    await fetchDatabase(makeHost(), '/.json');
    expect(cap().init?.redirect).toBe('error');
  });

  test('rejects a path that would escape the database origin', async () => {
    const cap = captureFetch();
    // Protocol-relative path reparses the authority to an attacker host.
    await expect(
      fetchDatabase(makeHost(), '//evil.example/x.json'),
    ).rejects.toThrow(/outside the database origin/);
    // The credential fetch must not have gone out to the attacker host.
    expect(cap().url).toBe('');
  });

  test('keeps an @-injection path on the database origin', async () => {
    const cap = captureFetch();
    await fetchDatabase(makeHost(), '/@evil.example/x.json');
    const { url } = cap();
    expect(new URL(url).origin).toBe('https://my-project-default-rtdb.firebaseio.com');
  });
});
