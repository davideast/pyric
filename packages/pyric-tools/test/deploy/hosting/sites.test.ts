/**
 * Tests for site provisioning. Mock fetch and assert URL/body shape
 * + the discriminated outcome for each failure branch.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createHostingSite, ensureHostingSite } from '../../../src/deploy/hosting/sites.js';

let originalFetch: typeof fetch;
let lastCall: { url: string; method: string; body: unknown; headers: Record<string, string> } | null;

function mockFetch(handler: () => Response | Promise<Response>): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* keep as string */ }
    }
    lastCall = { url, method, body, headers: (init?.headers as Record<string, string>) ?? {} };
    return handler();
  }) as typeof fetch;
}

beforeEach(() => { lastCall = null; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('createHostingSite', () => {
  test('happy path returns the site resource', async () => {
    mockFetch(() => new Response(JSON.stringify({
      name: 'projects/12345/sites/my-new-site',
      defaultUrl: 'https://my-new-site.web.app',
      type: 'USER_SITE',
    }), { status: 200 }));
    const result = await createHostingSite({ projectId: 'p', siteId: 'my-new-site', accessToken: 'tok' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.site.name).toBe('projects/12345/sites/my-new-site');
    expect(result.site.defaultUrl).toBe('https://my-new-site.web.app');
    // URL/body shape.
    expect(lastCall?.url).toBe('https://firebasehosting.googleapis.com/v1beta1/projects/p/sites?siteId=my-new-site');
    expect(lastCall?.method).toBe('POST');
    expect(lastCall?.body).toEqual({});
  });

  test('appId flows through to the request body', async () => {
    mockFetch(() => new Response(JSON.stringify({ name: 'projects/12345/sites/x' }), { status: 200 }));
    await createHostingSite({ projectId: 'p', siteId: 'x', appId: '1:abc:web:def', accessToken: 'tok' });
    expect(lastCall?.body).toEqual({ appId: '1:abc:web:def' });
  });

  test('409 → already_exists', async () => {
    mockFetch(() => new Response('site exists', { status: 409 }));
    const result = await createHostingSite({ projectId: 'p', siteId: 'taken', accessToken: 'tok' });
    expect(result.kind).toBe('already_exists');
  });

  test('400 → invalid_id with upstream message', async () => {
    mockFetch(() => new Response('invalid site id format', { status: 400 }));
    const result = await createHostingSite({ projectId: 'p', siteId: 'BAD-ID', accessToken: 'tok' });
    expect(result.kind).toBe('invalid_id');
    if (result.kind !== 'invalid_id') throw new Error('unreachable');
    expect(result.message).toContain('invalid site id format');
  });

  test('403 → permission_denied with role hint', async () => {
    mockFetch(() => new Response('forbidden', { status: 403 }));
    const result = await createHostingSite({ projectId: 'p', siteId: 'x', accessToken: 'tok' });
    expect(result.kind).toBe('permission_denied');
    if (result.kind !== 'permission_denied') throw new Error('unreachable');
    expect(result.message).toContain('roles/firebasehosting.admin');
  });

  test('network failure → network_error', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const result = await createHostingSite({ projectId: 'p', siteId: 'x', accessToken: 'tok' });
    expect(result.kind).toBe('network_error');
  });
});

describe('ensureHostingSite', () => {
  test('ok → created', async () => {
    mockFetch(() => new Response(JSON.stringify({ name: 'projects/12345/sites/x' }), { status: 200 }));
    const result = await ensureHostingSite({ projectId: 'p', siteId: 'x', accessToken: 'tok' });
    expect(result.kind).toBe('created');
  });

  test('409 → existed (treated as success)', async () => {
    mockFetch(() => new Response('exists', { status: 409 }));
    const result = await ensureHostingSite({ projectId: 'p', siteId: 'x', accessToken: 'tok' });
    expect(result.kind).toBe('existed');
  });

  test('non-ok-non-409 propagates the underlying outcome', async () => {
    mockFetch(() => new Response('forbidden', { status: 403 }));
    const result = await ensureHostingSite({ projectId: 'p', siteId: 'x', accessToken: 'tok' });
    expect(result.kind).toBe('permission_denied');
  });
});
