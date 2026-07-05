import { describe, test, expect } from 'bun:test';
import { ManageDomainsHandler } from '../../../src/auth/domains/handler.js';
import type { ProjectScope } from 'pyric-tools/deploy';

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

let capturedUrl = '';
let capturedBody = '';

const MOCK_SCOPE: ProjectScope = {
  projectId: 'test-project',
  resolveToken: async () => 'mock-token',
};

function mockFetchWithDomains(domains: string[]) {
  let callCount = 0;
  (global as any).fetch = async (url: string, init?: RequestInit) => {
    callCount++;
    capturedUrl = url;
    capturedBody = init?.body ? String(init.body) : '';
    // First call is GET (read current), second is PATCH (write)
    return new Response(JSON.stringify({ authorizedDomains: domains }), { status: 200 });
  };
}

describe('ManageDomainsHandler', () => {
  const handler = new ManageDomainsHandler();

  test('list returns current domains', async () => {
    mockFetchWithDomains(['localhost', 'example.web.app']);
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'list' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.authorizedDomains).toEqual(['localhost', 'example.web.app']);
      }
    } finally { restoreFetch(); }
  });

  test('add appends domain and patches', async () => {
    mockFetchWithDomains(['localhost']);
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'add', domain: 'new.web.app' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.authorizedDomains).toContain('new.web.app');
        expect(result.authorizedDomains).toContain('localhost');
      }
      expect(capturedUrl).toContain('updateMask=authorizedDomains');
      expect(capturedBody).toContain('new.web.app');
    } finally { restoreFetch(); }
  });

  test('add existing domain is no-op', async () => {
    let patchCalled = false;
    let callCount = 0;
    (global as any).fetch = async (url: string, init?: RequestInit) => {
      callCount++;
      if (init?.method === 'PATCH') patchCalled = true;
      return new Response(JSON.stringify({ authorizedDomains: ['localhost', 'existing.web.app'] }), { status: 200 });
    };
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'add', domain: 'existing.web.app' });
      expect(result.success).toBe(true);
      expect(patchCalled).toBe(false); // Should not PATCH
    } finally { restoreFetch(); }
  });

  test('remove deletes domain and patches', async () => {
    mockFetchWithDomains(['localhost', 'old.web.app']);
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'remove', domain: 'old.web.app' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.authorizedDomains).not.toContain('old.web.app');
        expect(result.authorizedDomains).toContain('localhost');
      }
    } finally { restoreFetch(); }
  });

  test('remove non-existent domain is no-op', async () => {
    let patchCalled = false;
    (global as any).fetch = async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') patchCalled = true;
      return new Response(JSON.stringify({ authorizedDomains: ['localhost'] }), { status: 200 });
    };
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'remove', domain: 'missing.web.app' });
      expect(result.success).toBe(true);
      expect(patchCalled).toBe(false);
    } finally { restoreFetch(); }
  });

  test('remove localhost returns warning', async () => {
    mockFetchWithDomains(['localhost', 'prod.web.app']);
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'remove', domain: 'localhost' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.warning).toBeDefined();
        expect(result.warning).toContain('local development');
      }
    } finally { restoreFetch(); }
  });

  test('empty domain returns error', async () => {
    mockFetchWithDomains(['localhost']);
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'add', domain: '' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_DOMAIN');
    } finally { restoreFetch(); }
  });

  test('403 returns PERMISSION_DENIED', async () => {
    (global as any).fetch = async () => new Response('', { status: 403 });
    try {
      const result = await handler.execute(MOCK_SCOPE, { action: 'list' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PERMISSION_DENIED');
    } finally { restoreFetch(); }
  });
});
