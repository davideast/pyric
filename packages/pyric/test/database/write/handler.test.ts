import { describe, test, expect } from 'bun:test';
import { WriteRulesHandler } from '../../../src/database/write/handler.js';
import type { RtdbHost } from '../../../src/database/host.js';
import type { RtdbIR, RtdbNode } from '../../../src/database/types.js';
import { buildRuleExpression } from '../../../src/database/mapper.js';
import { UNSUPPORTED_DATA_TRANSPORT } from '../fixtures.js';

const DATABASE_URL = 'https://test-default-rtdb.firebaseio.com';

function makeIR(): RtdbIR {
  const rootNode: RtdbNode = {
    path: '/',
    pathVariables: [],
    exists: false,
    read: buildRuleExpression('auth !== null', 'read'),
    write: buildRuleExpression('false', 'write'),
    children: [],
  };
  return {
    service: 'realtime-database',
    databaseUrl: DATABASE_URL,
    rules: rootNode,
  };
}

function mockApp(): RtdbHost {
  return {
    projectId: 'test-project',
    databaseUrl: DATABASE_URL,
    resolveAdminToken: async () => 'mock-token',
    resolveUserToken: async () => 'mock-user-token',
    data: UNSUPPORTED_DATA_TRANSPORT,
  };
}

// Capture what fetch receives
let capturedFetchUrl = '';
let capturedFetchInit: RequestInit | undefined;
const originalFetch = global.fetch;

function installFetchMock(status: number, statusText = 'OK') {
  capturedFetchUrl = '';
  capturedFetchInit = undefined;
  (global as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = url.toString();
    capturedFetchInit = init;
    return new Response('{}', { status, statusText });
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

describe('WriteRulesHandler', () => {
  const handler = new WriteRulesHandler();
  const ir = makeIR();

  test('returns success when PUT returns 200', async () => {
    installFetchMock(200);
    try {
      const result = await handler.execute(mockApp(), ir);
      expect(result.success).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  test('returns PERMISSION_DENIED on 403', async () => {
    installFetchMock(403, 'Forbidden');
    try {
      const result = await handler.execute(mockApp(), ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PERMISSION_DENIED');
        expect(result.error.recoverable).toBe(false);
      }
    } finally {
      restoreFetch();
    }
  });

  test('returns INVALID_RULES_JSON on 400 with recoverable=true', async () => {
    installFetchMock(400, 'Bad Request');
    try {
      const result = await handler.execute(mockApp(), ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_RULES_JSON');
        expect(result.error.recoverable).toBe(true);
      }
    } finally {
      restoreFetch();
    }
  });

  test('returns WRITE_FAILED on 500', async () => {
    installFetchMock(500, 'Internal Server Error');
    try {
      const result = await handler.execute(mockApp(), ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('WRITE_FAILED');
        expect(result.error.recoverable).toBe(false);
      }
    } finally {
      restoreFetch();
    }
  });

  test('returns WRITE_FAILED on network error', async () => {
    (global as any).fetch = async () => {
      throw new Error('Network failure');
    };
    try {
      const result = await handler.execute(mockApp(), ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('WRITE_FAILED');
        expect(result.error.message).toContain('Network failure');
      }
    } finally {
      restoreFetch();
    }
  });

  test('sends PUT with application/json content-type', async () => {
    installFetchMock(200);
    try {
      await handler.execute(mockApp(), ir);
      expect(capturedFetchInit?.method).toBe('PUT');
      expect((capturedFetchInit?.headers as Record<string, string>)?.['Content-Type']).toBe('application/json');
    } finally {
      restoreFetch();
    }
  });

  test('URL includes access_token from getRestToken', async () => {
    installFetchMock(200);
    try {
      await handler.execute(mockApp(), ir);
      expect(capturedFetchUrl).toContain('access_token=mock-token');
      expect(capturedFetchUrl).toContain('/.settings/rules.json');
    } finally {
      restoreFetch();
    }
  });

  test('body contains assembled rules JSON', async () => {
    installFetchMock(200);
    try {
      await handler.execute(mockApp(), ir);
      const body = JSON.parse(capturedFetchInit?.body as string);
      expect(body).toHaveProperty('rules');
      expect(body.rules['.read']).toBe('auth !== null');
      expect(body.rules['.write']).toBe(false);
    } finally {
      restoreFetch();
    }
  });
});
