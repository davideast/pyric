import { describe, test, expect } from 'bun:test';
import { ValidatedWriteHandler } from '../../../src/database/data/validated.js';
import type { RtdbTools } from '../../../src/database/types.js';
import type { RtdbHost } from '../../../src/database/host.js';
import type { StructureNode } from '../../../src/database/crawl/spec.js';

const BASE_APP: RtdbHost = {
  projectId: 'test-project',
  databaseUrl: 'https://test-db.firebaseio.com',
  data: {
    get: async () => null,
    set: async () => {},
    update: async () => {},
    push: async () => ({ key: '-Nkey' }),
    remove: async () => {},
  },
  resolveAdminToken: async () => 'mock-token',
  resolveUserToken: async () => 'mock-user-token',
};

const userSchema: StructureNode = {
  path: '/users/alice',
  childCount: 2,
  truncated: false,
  schema: { name: 'string', role: 'string' },
  children: [],
};

function mockDb(overrides?: Partial<{
  crawlResult: any;
  simulateResult: any;
}>): RtdbTools {
  return {
    generateIR: async () => ({ success: true as const, data: {} as any }),
    simulate: () => overrides?.simulateResult ?? ({
      success: true as const,
      data: { allowed: true, matchedPath: '/', matchedRule: 'true', reason: 'allowed', pathVariableBindings: {} },
    }),
    writeRules: async () => ({ success: true as const }),
    crawlStructure: async () => overrides?.crawlResult ?? ({
      success: true as const,
      data: {
        path: '/',
        childCount: 1,
        truncated: false,
        schema: {},
        children: [
          {
            path: '/users',
            childCount: 1,
            truncated: false,
            schema: {},
            children: [userSchema],
          },
        ],
      },
    }),
    readData: async () => ({ success: true as const, data: null }),
    setData: async () => ({ success: true as const, data: null }),
    updateData: async () => ({ success: true as const, data: null }),
    pushData: async () => ({ success: true as const, data: null }),
    removeData: async () => ({ success: true as const, data: null }),
    validatedWrite: async () => ({ success: true as const, data: null, schemaWarnings: [], simulationResult: null }),
  };
}

describe('ValidatedWriteHandler', () => {
  test('succeeds with matching schema and no warnings', async () => {
    const handler = new ValidatedWriteHandler();
    const result = await handler.execute(BASE_APP, mockDb(), {
      path: '/users/alice',
      data: { name: 'Alice', role: 'admin' },
      operation: 'set',
      auth: { uid: 'alice', token: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.schemaWarnings).toHaveLength(0);
    }
  });

  test('reports type_mismatch when value type differs from schema', async () => {
    const handler = new ValidatedWriteHandler();
    const result = await handler.execute(BASE_APP, mockDb(), {
      path: '/users/alice',
      data: { name: 123, role: 'user' },
      operation: 'set',
      auth: { uid: 'alice', token: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const mismatch = result.schemaWarnings.find(w => w.field === 'name');
      expect(mismatch).toBeDefined();
      expect(mismatch?.issue).toBe('type_mismatch');
      expect(mismatch?.expected).toBe('string');
      expect(mismatch?.actual).toBe('number');
    }
  });

  test('reports new_field for fields not in schema', async () => {
    const handler = new ValidatedWriteHandler();
    const result = await handler.execute(BASE_APP, mockDb(), {
      path: '/users/alice',
      data: { name: 'Alice', role: 'admin', email: 'a@b.com' },
      operation: 'set',
      auth: { uid: 'alice', token: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const newField = result.schemaWarnings.find(w => w.field === 'email');
      expect(newField).toBeDefined();
      expect(newField?.issue).toBe('new_field');
    }
  });

  test('blocks write when simulation denies access (admin mode)', async () => {
    const handler = new ValidatedWriteHandler();
    const db = mockDb({
      simulateResult: {
        success: true as const,
        data: { allowed: false, matchedPath: '/', matchedRule: 'false', reason: 'denied', pathVariableBindings: {} },
      },
    });
    const result = await handler.execute(BASE_APP, db, {
      path: '/users/alice',
      data: { name: 'Alice' },
      operation: 'set',
      auth: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SIMULATION_DENIED');
    }
  });

  test('user-mode: simulation denial does NOT block write (advisory only)', async () => {
    const handler = new ValidatedWriteHandler();
    const db = mockDb({
      simulateResult: {
        success: true as const,
        data: { allowed: false, matchedPath: '/', matchedRule: 'false', reason: 'denied', pathVariableBindings: {} },
      },
    });
    const result = await handler.execute(BASE_APP, db, {
      path: '/todos/team1/todo1',
      data: { title: 'Test', createdBy: 'alice' },
      operation: 'set',
      auth: { uid: 'alice', token: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.simulationResult?.allowed).toBe(false);
    }
  });

  test('skips simulation when IR not generated and proceeds with write', async () => {
    const handler = new ValidatedWriteHandler();
    const db = mockDb({
      simulateResult: {
        success: false as const,
        error: { code: 'IR_NOT_GENERATED' as const, message: 'no IR', recoverable: true },
      },
    });
    const result = await handler.execute(BASE_APP, db, {
      path: '/users/bob',
      data: { name: 'Bob' },
      operation: 'set',
      auth: { uid: 'bob', token: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.simulationResult).toBeNull();
    }
  });
});
