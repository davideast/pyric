import { describe, test, expect, mock } from 'bun:test';
import { DataHandler } from '../../../src/database/data/handler.js';
import type { RtdbHost } from '../../../src/database/host.js';

// Mock the firebase-admin/database module
const mockSnap = { val: () => null as unknown };
const mockRef = {
  get: async () => mockSnap,
  set: mock(async () => {}),
  update: mock(async () => {}),
  push: mock(async () => ({ key: '-NautoKey123' })),
  remove: mock(async () => {}),
};

mock.module('firebase-admin/database', () => ({
  getDatabase: () => ({
    ref: (_path: string) => mockRef,
  }),
  getDatabaseWithUrl: () => ({
    ref: (_path: string) => mockRef,
  }),
}));

// Mock the firebase/database module
const mockClientSnap = { val: () => null as unknown };
const mockClientRef = { toString: () => 'mock-ref' };
let clientGetResult = mockClientSnap;

mock.module('firebase/database', () => ({
  ref: (_db: unknown, _path: string) => mockClientRef,
  get: async () => clientGetResult,
  set: mock(async () => {}),
  update: mock(async () => {}),
  push: mock(async () => ({ key: '-NclientKey456' })),
  remove: mock(async () => {}),
}));

function mockApp(): RtdbHost {
  return {
    projectId: 'test-project',
    databaseUrl: 'https://test-db.firebaseio.com',
    resolveAdminToken: async () => 'mock-token',
    resolveUserToken: async () => 'mock-user-token',
    getClientForUser: async () => ({}) as never,
  };
}

describe('DataHandler', () => {
  const handler = new DataHandler();

  // ═══ Admin mode (uses firebase-admin SDK) ═══

  test('admin GET reads data at path', async () => {
    mockSnap.val = () => ({ name: 'Alice', role: 'admin' });
    const result = await handler.execute(mockApp(), 'get', '/users/alice');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'Alice', role: 'admin' });
    }
  });

  test('admin GET returns null for empty path', async () => {
    mockSnap.val = () => null;
    const result = await handler.execute(mockApp(), 'get', '/empty');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
    }
  });

  test('admin SET writes data', async () => {
    const result = await handler.execute(mockApp(), 'set', '/users/bob', { name: 'Bob' });
    expect(result.success).toBe(true);
  });

  test('admin UPDATE merges data', async () => {
    const result = await handler.execute(mockApp(), 'update', '/users/bob', { email: 'bob@test.com' });
    expect(result.success).toBe(true);
  });

  test('admin PUSH returns key', async () => {
    const result = await handler.execute(mockApp(), 'push', '/posts', { title: 'New Post' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ key: '-NautoKey123' });
    }
  });

  test('admin REMOVE deletes data', async () => {
    const result = await handler.execute(mockApp(), 'remove', '/users/bob');
    expect(result.success).toBe(true);
  });

  // ═══ User mode (uses firebase client SDK via FirebaseServerApp) ═══

  test('user mode GET reads data with rules enforced', async () => {
    clientGetResult = { val: () => ({ name: 'Alice' }) };
    const result = await handler.execute(mockApp(), 'get', '/users/alice', undefined, { uid: 'alice' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'Alice' });
    }
  });

  test('user mode SET writes data with rules enforced', async () => {
    const result = await handler.execute(mockApp(), 'set', '/users/alice', { name: 'Alice' }, { uid: 'alice' });
    expect(result.success).toBe(true);
  });

  test('user mode UPDATE merges with rules enforced', async () => {
    const result = await handler.execute(mockApp(), 'update', '/users/alice', { email: 'a@b.com' }, { uid: 'alice' });
    expect(result.success).toBe(true);
  });

  test('user mode PUSH returns key with rules enforced', async () => {
    const result = await handler.execute(mockApp(), 'push', '/posts', { title: 'Post' }, { uid: 'alice' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ key: '-NclientKey456' });
    }
  });

  test('user mode REMOVE deletes with rules enforced', async () => {
    const result = await handler.execute(mockApp(), 'remove', '/users/alice', undefined, { uid: 'alice' });
    expect(result.success).toBe(true);
  });

  // ═══ Error handling ═══

  test('error returns READ_FAILED for get', async () => {
    const app = mockApp();
    app.getClientForUser = async () => { throw new Error('Connection refused'); };
    const result = await handler.execute(app, 'get', '/data', undefined, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('READ_FAILED');
      expect(result.error.message).toContain('Connection refused');
    }
  });

  test('error returns WRITE_FAILED for set', async () => {
    const app = mockApp();
    app.getClientForUser = async () => { throw new Error('Timeout'); };
    const result = await handler.execute(app, 'set', '/data', { x: 1 }, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('WRITE_FAILED');
    }
  });

  // ═══ Rules-denied surfaces as PERMISSION_DENIED (not READ_FAILED / WRITE_FAILED) ═══

  // Matches the set/get/remove rules-denied shape from
  // packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json:
  //   plain Error, code: 'PERMISSION_DENIED' (uppercase),
  //   message: 'PERMISSION_DENIED: Permission denied'
  function makeRulesDeniedError(): Error {
    const err = new Error('PERMISSION_DENIED: Permission denied');
    (err as Error & { code?: string }).code = 'PERMISSION_DENIED';
    return err;
  }

  // Matches the runTransaction rules-denied shape from
  // packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json:
  //   plain Error, message: 'permission_denied' (lowercase), NO `.code` field
  function makeTransactionRulesDeniedError(): Error {
    return new Error('permission_denied');
  }

  test('rules-denied GET surfaces as PERMISSION_DENIED (not READ_FAILED)', async () => {
    // Oracle: packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json
    const app = mockApp();
    app.getClientForUser = async () => { throw makeRulesDeniedError(); };
    const result = await handler.execute(app, 'get', '/private', undefined, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('PERMISSION_DENIED');
    }
  });

  test('rules-denied SET surfaces as PERMISSION_DENIED (not WRITE_FAILED)', async () => {
    // Oracle: packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json
    const app = mockApp();
    app.getClientForUser = async () => { throw makeRulesDeniedError(); };
    const result = await handler.execute(app, 'set', '/private', { x: 1 }, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
    }
  });

  test('rules-denied REMOVE surfaces as PERMISSION_DENIED (not WRITE_FAILED)', async () => {
    // Oracle: packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json
    const app = mockApp();
    app.getClientForUser = async () => { throw makeRulesDeniedError(); };
    const result = await handler.execute(app, 'remove', '/private', undefined, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
    }
  });

  test('non-rules error for GET still surfaces as READ_FAILED (no false positive)', async () => {
    // Regression: a generic network failure must NOT be reclassified as
    // PERMISSION_DENIED just because the inspection is in place.
    const app = mockApp();
    app.getClientForUser = async () => { throw new Error('ENETUNREACH: network unreachable'); };
    const result = await handler.execute(app, 'get', '/data', undefined, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('READ_FAILED');
    }
  });

  test('non-rules error for SET still surfaces as WRITE_FAILED (no false positive)', async () => {
    // Regression for the inspection.
    const app = mockApp();
    app.getClientForUser = async () => { throw new Error('Timeout'); };
    const result = await handler.execute(app, 'set', '/data', { x: 1 }, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('WRITE_FAILED');
    }
  });

  test('transaction-shaped rules-denied (lowercase message, no .code) surfaces as PERMISSION_DENIED', async () => {
    // Oracle: packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json
    // The runTransaction error shape is `Error('permission_denied')` with NO
    // `.code` field — the inspection's `.message.toLowerCase()` branch must
    // catch it. Even though `runTransaction` is not exposed by DataHandler
    // directly, any wrapper that funnels its rejection through this handler
    // (or any caller that simulates this shape) gets the right code.
    const app = mockApp();
    app.getClientForUser = async () => { throw makeTransactionRulesDeniedError(); };
    const result = await handler.execute(app, 'set', '/private', { x: 1 }, { uid: 'u1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toBe('permission_denied');
    }
  });
});
