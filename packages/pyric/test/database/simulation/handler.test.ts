import { describe, test, expect } from 'bun:test';
import { SimulateHandler } from '../../../src/database/simulation/handler.js';
import type { RtdbIR, RtdbNode } from '../../../src/database/types.js';

function makeIR(readRule: string): RtdbIR {
  const rootNode: RtdbNode = {
    path: '/',
    pathVariables: [],
    exists: true,
    read: {
      raw: readRule,
      parsed: {
        raw: readRule,
        valid: true,
        errors: [],
        warnings: [],
        referencedIdentifiers: ['auth'],
      },
    },
    children: [],
  };
  return {
    service: 'realtime-database',
    databaseUrl: 'https://test-default-rtdb.firebaseio.com',
    rules: rootNode,
  };
}

describe('SimulateHandler', () => {
  const handler = new SimulateHandler();

  test('returns IR_NOT_GENERATED when ir is null', () => {
    const result = handler.execute(null, {
      operation: 'read',
      path: '/',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('IR_NOT_GENERATED');
      expect(result.error.recoverable).toBe(true);
    }
  });

  test('returns INVALID_INPUT for invalid input shape', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, { operation: 'DELETE', path: '/', auth: null, mockData: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  });

  test('returns allowed=true when auth matches rule', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/',
      auth: { uid: 'user123', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
    }
  });

  test('returns allowed=false when auth is null and rule requires auth', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
    }
  });

  test('returns matchedPath and matchedRule in result', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/',
      auth: { uid: 'abc', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matchedPath).toBe('/');
      expect(result.data.matchedRule).toBe('auth !== null');
    }
  });

  test('parent read rule cascades to child path', () => {
    const expr = (raw: string) => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const ir: RtdbIR = {
      service: 'realtime-database',
      databaseUrl: 'https://test.firebaseio.com',
      rules: {
        path: '/',
        pathVariables: [],
        exists: true,
        read: expr('false'),
        children: [
          {
            path: '/posts',
            pathVariables: [],
            exists: true,
            read: expr('true'),
            children: [
              {
                path: '/posts/$postId',
                pathVariables: ['$postId'],
                exists: false,
                // No read rule on $postId itself
                children: [
                  {
                    path: '/posts/$postId/likes',
                    pathVariables: ['$postId'],
                    exists: false,
                    // No read rule on likes either
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // /posts has .read: true — this should cascade to /posts/post1/likes
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/posts/post1/likes',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.matchedPath).toBe('/posts');
      expect(result.data.matchedRule).toBe('true');
    }
  });

  test('root write rule cascades to deep child', () => {
    const expr = (raw: string) => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const ir: RtdbIR = {
      service: 'realtime-database',
      databaseUrl: 'https://test.firebaseio.com',
      rules: {
        path: '/',
        pathVariables: [],
        exists: true,
        write: expr('auth !== null'),
        children: [
          {
            path: '/data',
            pathVariables: [],
            exists: true,
            children: [],
          },
        ],
      },
    };

    const result = handler.execute(ir, {
      operation: 'write',
      path: '/data',
      auth: { uid: 'user1', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.matchedPath).toBe('/');
    }
  });
});
