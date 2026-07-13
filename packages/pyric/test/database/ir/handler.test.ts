import { describe, test, expect, afterEach } from 'bun:test';
import { GenerateIRHandler } from '../../../src/database/ir/handler.js';
import type { RtdbHost } from '../../../src/database/host.js';
import { UNSUPPORTED_DATA_TRANSPORT } from '../fixtures.js';

const VALID_RULES = { rules: { '.read': 'auth !== null', '.write': 'false' } };
const DATABASE_URL = 'https://test-project-default-rtdb.firebaseio.com';

function makeHost(): RtdbHost {
  return {
    projectId: 'test-project',
    databaseUrl: DATABASE_URL,
    resolveAdminToken: async () => 'mock-token',
    resolveUserToken: async () => 'mock-user-token',
    data: UNSUPPORTED_DATA_TRANSPORT,
  };
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** Stub fetch with per-path responses. Path is extracted from the
 *  URL — everything before `?` after the databaseUrl. */
function stubFetch(routes: {
  rulesStatus?: number;
  rulesBody?: unknown;
  shallowStatus?: number;
  shallowBody?: unknown;
}): { calledPaths: string[] } {
  const {
    rulesStatus = 200,
    rulesBody = VALID_RULES,
    shallowStatus = 200,
    shallowBody = { users: true },
  } = routes;
  const calledPaths: string[] = [];
  (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const urlStr = input.toString();
    const path = urlStr.split('?')[0].replace(DATABASE_URL, '');
    calledPaths.push(path);
    if (path === '/.settings/rules.json') {
      return new Response(
        rulesStatus === 200 ? JSON.stringify(rulesBody) : 'Forbidden',
        { status: rulesStatus, statusText: rulesStatus === 403 ? 'Forbidden' : 'OK' },
      );
    }
    if (path === '/.json') {
      return new Response(
        shallowStatus === 200 ? JSON.stringify(shallowBody) : 'Not Found',
        { status: shallowStatus, statusText: shallowStatus === 404 ? 'Not Found' : 'OK' },
      );
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  return { calledPaths };
}

describe('GenerateIRHandler', () => {
  test('returns success with valid rules and shallow data', async () => {
    stubFetch({});
    const handler = new GenerateIRHandler();
    const result = await handler.execute(makeHost());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.service).toBe('realtime-database');
      expect(result.data.databaseUrl).toBe(DATABASE_URL);
    }
  });

  test('returns RULES_FETCH_FAILED when rules endpoint returns 403', async () => {
    stubFetch({ rulesStatus: 403 });
    const handler = new GenerateIRHandler();
    const result = await handler.execute(makeHost());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RULES_FETCH_FAILED');
      expect(result.error.recoverable).toBe(false);
    }
  });

  test('returns RULES_PARSE_FAILED when rules response is not valid JSON', async () => {
    (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
      const path = input.toString().split('?')[0].replace(DATABASE_URL, '');
      if (path === '/.settings/rules.json') {
        return new Response('not json {{', { status: 200, statusText: 'OK' });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const handler = new GenerateIRHandler();
    const result = await handler.execute(makeHost());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RULES_PARSE_FAILED');
    }
  });

  test('returns success even when shallow fetch returns 404', async () => {
    stubFetch({ shallowStatus: 404 });
    const handler = new GenerateIRHandler();
    const result = await handler.execute(makeHost());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules.exists).toBe(false);
    }
  });

  test('hits both /.settings/rules.json and /.json', async () => {
    const { calledPaths } = stubFetch({});
    const handler = new GenerateIRHandler();
    await handler.execute(makeHost());

    expect(calledPaths).toContain('/.settings/rules.json');
    expect(calledPaths).toContain('/.json');
  });
});
