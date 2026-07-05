import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getRtdbTools } from '../../src/database/resolver.js';
import type { RtdbHost } from '../../src/database/host.js';

const VALID_RULES = { rules: { '.read': 'auth !== null', '.write': 'false' } };
const DATABASE_URL = 'https://test-default-rtdb.firebaseio.com';

function makeHost(): RtdbHost {
  return {
    projectId: 'test-project',
    databaseUrl: DATABASE_URL,
    resolveAdminToken: async () => 'mock-admin-token',
    resolveUserToken: async () => 'mock-user-token',
    getClientForUser: async () => { throw new Error('not implemented'); },
  };
}

const realFetch = global.fetch;

/** Stub global fetch with a `(path) → Response` map. RTDB rule
 *  fetches go to `/.settings/rules.json`; shallow data goes to
 *  `/.json` etc. The fake returns 200 with `{}` for anything not
 *  explicitly scripted. */
function stubFetch(routes: { rulesOk?: boolean } = { rulesOk: true }) {
  (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes('/.settings/rules.json')) {
      return new Response(
        routes.rulesOk ? JSON.stringify(VALID_RULES) : 'Forbidden',
        { status: routes.rulesOk ? 200 : 403, statusText: routes.rulesOk ? 'OK' : 'Forbidden' },
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => stubFetch());
afterEach(() => { global.fetch = realFetch; });

describe('getRtdbTools', () => {
  test('generateIR returns success with valid host', async () => {
    const analyzer = getRtdbTools(makeHost());
    const result = await analyzer.generateIR();
    expect(result.success).toBe(true);
  });

  test('simulate before generateIR returns IR_NOT_GENERATED', () => {
    const analyzer = getRtdbTools(makeHost());
    const result = analyzer.simulate({
      operation: 'read',
      path: '/',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('IR_NOT_GENERATED');
    }
  });

  test('simulate after generateIR returns success', async () => {
    const analyzer = getRtdbTools(makeHost());
    await analyzer.generateIR();
    const result = analyzer.simulate({
      operation: 'read',
      path: '/',
      auth: { uid: 'user1', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
  });

  test('caches IR across multiple simulate calls', async () => {
    const analyzer = getRtdbTools(makeHost());
    await analyzer.generateIR();

    const r1 = analyzer.simulate({ operation: 'read', path: '/', auth: { uid: 'u1', token: {} }, mockData: {} });
    const r2 = analyzer.simulate({ operation: 'read', path: '/', auth: null, mockData: {} });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    if (r1.success) expect(r1.data.allowed).toBe(true);
    if (r2.success) expect(r2.data.allowed).toBe(false);
  });

  test('generateIR failure does not cache bad IR', async () => {
    stubFetch({ rulesOk: false });
    const analyzer = getRtdbTools(makeHost());
    const result = await analyzer.generateIR();
    expect(result.success).toBe(false);

    const simResult = analyzer.simulate({ operation: 'read', path: '/', auth: null, mockData: {} });
    expect(simResult.success).toBe(false);
    if (!simResult.success) {
      expect(simResult.error.code).toBe('IR_NOT_GENERATED');
    }
  });

  test('writeRules is a function on the analyzer', () => {
    const analyzer = getRtdbTools(makeHost());
    expect(typeof analyzer.writeRules).toBe('function');
  });

  test('writeRules delegates to WriteRulesHandler and returns result', async () => {
    const analyzer = getRtdbTools(makeHost());
    const irResult = await analyzer.generateIR();
    expect(irResult.success).toBe(true);
    if (!irResult.success) return;

    const result = await analyzer.writeRules(irResult.data);
    expect(result.success).toBe(true);
  });

  test('crawlStructure returns result', async () => {
    const analyzer = getRtdbTools(makeHost());
    const result = await analyzer.crawlStructure({ maxDepth: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/');
    }
  });

  test('returns an object containing all expected handler functions', () => {
    const analyzer = getRtdbTools(makeHost());
    expect(typeof analyzer.generateIR).toBe('function');
    expect(typeof analyzer.simulate).toBe('function');
    expect(typeof analyzer.writeRules).toBe('function');
    expect(typeof analyzer.crawlStructure).toBe('function');
    expect(typeof analyzer.readData).toBe('function');
    expect(typeof analyzer.setData).toBe('function');
    expect(typeof analyzer.updateData).toBe('function');
    expect(typeof analyzer.pushData).toBe('function');
    expect(typeof analyzer.removeData).toBe('function');
    expect(typeof analyzer.validatedWrite).toBe('function');
  });
});
