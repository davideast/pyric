import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getRtdbTools } from '../../src/database/resolver.js';
import type { RtdbHost } from '../../src/database/host.js';
import type { RtdbDataTransport } from '../../src/database/data/transport.js';

const VALID_RULES = { rules: { '.read': 'auth !== null', '.write': 'false' } };
const DATABASE_URL = 'https://test-default-rtdb.firebaseio.com';

const unsupported = async (): Promise<never> => {
  throw new Error('data transport not implemented for this test');
};

function makeDataTransport(
  overrides: Partial<RtdbDataTransport> = {},
): RtdbDataTransport {
  return {
    get: unsupported,
    set: unsupported,
    update: unsupported,
    push: unsupported,
    remove: unsupported,
    ...overrides,
  };
}

function makeHost(data: RtdbDataTransport = makeDataTransport()): RtdbHost {
  return {
    projectId: 'test-project',
    databaseUrl: DATABASE_URL,
    data,
    resolveAdminToken: async () => 'mock-admin-token',
    resolveUserToken: async () => 'mock-user-token',
  };
}

function hostWithDataFailure(error: Error): RtdbHost {
  const fail = async (): Promise<never> => { throw error; };
  return {
    ...makeHost(),
    data: makeDataTransport({
      get: fail,
      set: fail,
      update: fail,
      push: fail,
      remove: fail,
    }),
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
  test('readData preserves admin and user return shapes from the host data transport', async () => {
    const host = makeHost(makeDataTransport({
      get: async (_path, auth) => ({ name: auth?.uid ?? 'Admin' }),
    }));

    await expect(getRtdbTools(host).readData('/users/alice')).resolves.toEqual({
      success: true,
      data: { name: 'Admin' },
    });
    await expect(
      getRtdbTools(host).readData('/users/alice', { auth: { uid: 'alice' } }),
    ).resolves.toEqual({
      success: true,
      data: { name: 'alice' },
    });
  });

  test('readData preserves null for a missing path', async () => {
    const host = makeHost(makeDataTransport({ get: async () => null }));

    await expect(getRtdbTools(host).readData('/missing')).resolves.toEqual({
      success: true,
      data: null,
    });
  });

  test('setData preserves admin and user result shapes through the host data transport', async () => {
    const values = new Map<string, unknown>();
    const key = (path: string, uid = 'admin') => `${uid}:${path}`;
    const host = makeHost(makeDataTransport({
      get: async (path, auth) => values.get(key(path, auth?.uid)) ?? null,
      set: async (path, value, auth) => { values.set(key(path, auth?.uid), value); },
    }));
    const tools = getRtdbTools(host);

    await expect(tools.setData('/users/bob', { name: 'Bob' })).resolves.toEqual({
      success: true,
      data: null,
    });
    await expect(tools.readData('/users/bob')).resolves.toEqual({
      success: true,
      data: { name: 'Bob' },
    });
    await expect(
      tools.setData('/users/alice', { name: 'Alice' }, { auth: { uid: 'alice' } }),
    ).resolves.toEqual({ success: true, data: null });
    await expect(
      tools.readData('/users/alice', { auth: { uid: 'alice' } }),
    ).resolves.toEqual({ success: true, data: { name: 'Alice' } });
  });

  test('updateData preserves admin and user result shapes through the host data transport', async () => {
    const values = new Map<string, Record<string, unknown>>([
      ['admin:/users/bob', { name: 'Bob' }],
      ['alice:/users/alice', { name: 'Alice' }],
    ]);
    const key = (path: string, uid = 'admin') => `${uid}:${path}`;
    const host = makeHost(makeDataTransport({
      get: async (path, auth) => values.get(key(path, auth?.uid)) ?? null,
      update: async (path, value, auth) => {
        const target = key(path, auth?.uid);
        values.set(target, { ...(values.get(target) ?? {}), ...value });
      },
    }));
    const tools = getRtdbTools(host);

    await expect(tools.updateData('/users/bob', { role: 'admin' })).resolves.toEqual({
      success: true,
      data: null,
    });
    await expect(tools.readData('/users/bob')).resolves.toEqual({
      success: true,
      data: { name: 'Bob', role: 'admin' },
    });
    await expect(
      tools.updateData('/users/alice', { role: 'member' }, { auth: { uid: 'alice' } }),
    ).resolves.toEqual({ success: true, data: null });
    await expect(
      tools.readData('/users/alice', { auth: { uid: 'alice' } }),
    ).resolves.toEqual({
      success: true,
      data: { name: 'Alice', role: 'member' },
    });
  });

  test('pushData preserves admin and user keys from the host data transport', async () => {
    const host = makeHost(makeDataTransport({
      push: async (_path, _value, auth) => ({
        key: auth ? '-NuserTransportKey' : '-NadminTransportKey',
      }),
    }));

    await expect(
      getRtdbTools(host).pushData('/posts', { title: 'Transport owned' }),
    ).resolves.toEqual({
      success: true,
      data: { key: '-NadminTransportKey' },
    });
    await expect(
      getRtdbTools(host).pushData(
        '/posts',
        { title: 'User transport' },
        { auth: { uid: 'alice' } },
      ),
    ).resolves.toEqual({
      success: true,
      data: { key: '-NuserTransportKey' },
    });
  });

  test('removeData preserves admin and user result shapes through the host data transport', async () => {
    const values = new Map<string, unknown>();
    const key = (path: string, uid = 'admin') => `${uid}:${path}`;
    const host = makeHost(makeDataTransport({
      get: async (path, auth) => values.get(key(path, auth?.uid)) ?? null,
      set: async (path, value, auth) => { values.set(key(path, auth?.uid), value); },
      remove: async (path, auth) => { values.delete(key(path, auth?.uid)); },
    }));
    const tools = getRtdbTools(host);
    await tools.setData('/users/bob', { name: 'Bob' });
    await tools.setData('/users/alice', { name: 'Alice' }, { auth: { uid: 'alice' } });

    await expect(tools.removeData('/users/bob')).resolves.toEqual({
      success: true,
      data: null,
    });
    await expect(tools.readData('/users/bob')).resolves.toEqual({
      success: true,
      data: null,
    });
    await expect(
      tools.removeData('/users/alice', { auth: { uid: 'alice' } }),
    ).resolves.toEqual({ success: true, data: null });
    await expect(
      tools.readData('/users/alice', { auth: { uid: 'alice' } }),
    ).resolves.toEqual({ success: true, data: null });
  });

  test('readData passes user identity to the host data transport', async () => {
    const host = makeHost(makeDataTransport({
      get: async (_path, auth) => auth ?? null,
    }));

    await expect(
      getRtdbTools(host).readData('/private', { auth: { uid: 'alice' } }),
    ).resolves.toEqual({
      success: true,
      data: { uid: 'alice' },
    });
  });

  test('readData normalizes transport failures as READ_FAILED', async () => {
    const host = hostWithDataFailure(new Error('Connection refused'));

    await expect(getRtdbTools(host).readData('/data')).resolves.toEqual({
      success: false,
      error: {
        code: 'READ_FAILED',
        message: 'Connection refused',
        recoverable: false,
      },
    });
  });

  test('write methods normalize transport failures as WRITE_FAILED', async () => {
    const host = hostWithDataFailure(new Error('Timeout'));
    const tools = getRtdbTools(host);
    const writes = [undefined, { auth: { uid: 'alice' } }].flatMap((options) => [
      tools.setData('/data', { x: 1 }, options),
      tools.updateData('/data', { x: 1 }, options),
      tools.pushData('/data', { x: 1 }, options),
      tools.removeData('/data', options),
    ]);

    for (const write of writes) {
      await expect(write).resolves.toEqual({
        success: false,
        error: {
          code: 'WRITE_FAILED',
          message: 'Timeout',
          recoverable: false,
        },
      });
    }
  });

  test('every data method preserves uppercase PERMISSION_DENIED transport errors', async () => {
    const error = new Error('PERMISSION_DENIED: Permission denied');
    (error as Error & { code?: string }).code = 'PERMISSION_DENIED';
    const host = hostWithDataFailure(error);

    const tools = getRtdbTools(host);
    const options = { auth: { uid: 'alice' } };
    const operations = [
      tools.readData('/private', options),
      tools.setData('/private', { x: 1 }, options),
      tools.updateData('/private', { x: 1 }, options),
      tools.pushData('/private', { x: 1 }, options),
      tools.removeData('/private', options),
    ];

    for (const operation of operations) {
      const result = await operation;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PERMISSION_DENIED');
        expect(result.error.message).toBe('PERMISSION_DENIED: Permission denied');
      }
    }
  });

  test('lowercase permission_denied transport errors preserve PERMISSION_DENIED', async () => {
    const host = hostWithDataFailure(new Error('permission_denied'));

    const result = await getRtdbTools(host).setData('/private', { x: 1 }, {
      auth: { uid: 'alice' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toBe('permission_denied');
    }
  });

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
