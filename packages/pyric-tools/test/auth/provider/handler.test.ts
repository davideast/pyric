import { describe, test, expect } from 'bun:test';
import { ConfigureProviderHandler } from '../../../src/auth/provider/handler.js';
import type { ProjectScope } from 'pyric-tools/deploy';

let capturedUrl = '';
let capturedMethod = '';
let capturedBody = '';
const originalFetch = global.fetch;

function installFetchMock(status: number, body: unknown = {}) {
  capturedUrl = '';
  capturedMethod = '';
  capturedBody = '';
  (global as any).fetch = async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedMethod = init?.method || 'GET';
    capturedBody = init?.body ? String(init.body) : '';
    return new Response(JSON.stringify(body), { status });
  };
}

function restoreFetch() { global.fetch = originalFetch; }

const MOCK_SCOPE: ProjectScope = {
  projectId: 'test-project',
  resolveToken: async () => 'mock-token',
};

describe('ConfigureProviderHandler', () => {
  const handler = new ConfigureProviderHandler();

  test('anonymous enable calls correct endpoint', async () => {
    installFetchMock(200);
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'anonymous', enabled: true });
      expect(result.success).toBe(true);
      expect(capturedUrl).toContain('/config?updateMask=signIn.anonymous.enabled');
      expect(capturedMethod).toBe('PATCH');
      expect(capturedBody).toContain('"anonymous"');
      expect(capturedBody).toContain('"enabled":true');
    } finally { restoreFetch(); }
  });

  test('anonymous disable sets enabled false', async () => {
    installFetchMock(200);
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'anonymous', enabled: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.provider).toBe('anonymous');
        expect(result.enabled).toBe(false);
      }
      expect(capturedBody).toContain('"enabled":false');
    } finally { restoreFetch(); }
  });

  test('email enable includes passwordRequired', async () => {
    installFetchMock(200);
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'email', enabled: true });
      expect(result.success).toBe(true);
      expect(capturedUrl).toContain('signIn.email.enabled,signIn.email.passwordRequired');
      expect(capturedBody).toContain('"passwordRequired":true');
    } finally { restoreFetch(); }
  });

  test('phone enable returns billing warning', async () => {
    installFetchMock(200);
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'phone', enabled: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.warning).toBeDefined();
        expect(result.warning).toContain('billing');
      }
    } finally { restoreFetch(); }
  });

  test('phone disable has no warning', async () => {
    installFetchMock(200);
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'phone', enabled: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.warning).toBeUndefined();
      }
    } finally { restoreFetch(); }
  });

  test('google enable checks existence then patches', async () => {
    let callCount = 0;
    (global as any).fetch = async (url: string, init?: RequestInit) => {
      callCount++;
      capturedUrl = url;
      capturedMethod = init?.method || 'GET';
      if (callCount === 1) {
        // First call: GET to check existence
        return new Response(JSON.stringify({ enabled: false, clientId: 'test' }), { status: 200 });
      }
      // Second call: PATCH to enable
      return new Response(JSON.stringify({ enabled: true }), { status: 200 });
    };
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'google', enabled: true });
      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
      expect(capturedMethod).toBe('PATCH');
      expect(capturedUrl).toContain('google.com?updateMask=enabled');
    } finally { restoreFetch(); }
  });

  test('google returns error when not provisioned (404)', async () => {
    (global as any).fetch = async () => new Response('{"error":"not found"}', { status: 404 });
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'google', enabled: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GOOGLE_NOT_PROVISIONED');
        expect(result.error.message).toContain('Firebase Console');
      }
    } finally { restoreFetch(); }
  });

  test('403 returns PERMISSION_DENIED', async () => {
    installFetchMock(403);
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'anonymous', enabled: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PERMISSION_DENIED');
      }
    } finally { restoreFetch(); }
  });

  test('500 returns PROVIDER_CONFIG_FAILED', async () => {
    installFetchMock(500, { error: 'internal' });
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'email', enabled: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PROVIDER_CONFIG_FAILED');
      }
    } finally { restoreFetch(); }
  });

  test('network error returns PROVIDER_CONFIG_FAILED', async () => {
    (global as any).fetch = async () => { throw new Error('Network failure'); };
    try {
      const result = await handler.execute(MOCK_SCOPE, { provider: 'anonymous', enabled: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PROVIDER_CONFIG_FAILED');
        expect(result.error.message).toContain('Network failure');
      }
    } finally { restoreFetch(); }
  });
});
