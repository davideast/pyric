import { describe, expect, test } from 'bun:test';
import { defineRtdbRules } from '../../../../src/rules/rtdb/constraints/document.js';
import { z } from 'zod';
import { rtdbRules, serverTimestamp } from '../../../../src/rules/index.js';
import {
  all,
  allow,
  authenticated,
  dataVal,
  defineRtdbRules,
  deny,
  eq,
  expr,
  immutable,
  newDataVal,
  pathOwnerOnly,
  ruleset,
} from '../../../../src/rules/rtdb/constraints/index.js';

describe('defineRtdbRules', () => {
  test('compiles constraints to rules JSON', () => {
    const rules = defineRtdbRules({
      paths: {
        '/': { read: deny(), write: deny() },
        '/rooms/$roomId/messages/$messageId': {
          read: allow(),
          write: all(pathOwnerOnly('$messageId'), immutable('createdAt')),
          schema: z.object({
            author: z.string(),
            text: z.string(),
            createdAt: z.number(),
          }),
          indexOn: ['createdAt'],
        },
      },
    });

    expect(rules.toJSON()).toEqual({
      rules: {
        '.read': false,
        '.write': false,
        rooms: {
          '$roomId': {
            messages: {
              '.indexOn': ['createdAt'],
              '$messageId': {
                '.read': true,
                '.write': "auth != null && auth.uid == $messageId && (!data.exists() || newData.child('createdAt').val() == data.child('createdAt').val())",
                '.validate': "newData.hasChildren() && newData.hasChild('author') && newData.hasChild('text') && newData.hasChild('createdAt')",
                author: { '.validate': 'newData.isString()' },
                text: { '.validate': 'newData.isString()' },
                createdAt: { '.validate': 'newData.isNumber()' },
              },
            },
          },
        },
      },
    });
  });

  test('compiles plain-path indexOn without emitting an empty wildcard node', () => {
    const def = defineRtdbRules({
      paths: {
        '/jobs': {
          read: authenticated(),
          indexOn: ['runAt'],
        },
      },
    });
    const handle = rtdbRules(def);

    expect(handle.lint()).toEqual([]);
    expect(handle.toJSON()).toEqual({
      rules: {
        jobs: {
          '.read': 'auth != null',
          '.indexOn': ['runAt'],
        },
      },
    });

    const summary = handle.simulate([
      {
        description: 'ordered query on /jobs uses the plain-path .indexOn',
        expectation: 'ALLOW',
        operation: 'read',
        path: '/jobs',
        auth: 'alice',
        query: { orderByChild: 'runAt' },
      },
    ]);
    expect(summary.passed).toBe(1);
    expect(summary.coverage.missingIndexes).toEqual([]);
    expect(summary.coverage.rules.find(r => r.path === '/jobs' && r.kind === 'indexOn')?.status).toBe('allow');
  });

  test('compiles without database or service metadata', () => {
    const rules = defineRtdbRules({
      paths: {
        '/': { read: deny(), write: deny() },
      },
    });

    const compiled = rules.compile();
    expect(compiled.path).toBe('/');
    expect(compiled).not.toHaveProperty('databaseUrl');
    expect(compiled).not.toHaveProperty('service');
  });

  test('check collects parser errors and lint warnings', () => {
    const rules = defineRtdbRules({
      paths: {
        '/': { read: expr('auth.uid =='), write: expr('data.exists()') },
      },
    });

    const check = rules.check();
    expect(check.ok).toBe(false);
    expect(check.errors.map(e => e.code).length).toBeGreaterThan(0);
    expect(check.warnings.map(w => w.code)).toContain('DATA_IN_WRITE');
    expect(check.warnings.map(w => w.code)).not.toContain('LOOSE_EQUALITY');
  });

  test('check converts compile failures to COMPILE_ERROR findings', () => {
    const rules = defineRtdbRules({
      paths: {
        '/items/$itemId': {
          schema: z.object({ tags: z.array(z.string()) }),
        },
      },
    });

    const check = rules.check();
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual([
      expect.objectContaining({
        path: '/',
        rule: 'ruleset',
        code: 'COMPILE_ERROR',
      }),
    ]);
  });

  test('check reports COMPILE_ERROR when parent and wildcard child have conflicting indexOn', () => {
    const rules = defineRtdbRules({
      paths: {
        '/jobs': { read: allow(), indexOn: ['runAt'] },
        '/jobs/$jobId': { write: allow(), indexOn: ['priority'] },
      },
    });

    const check = rules.check();
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual([
      expect.objectContaining({
        path: '/',
        rule: 'ruleset',
        code: 'COMPILE_ERROR',
        message: expect.stringContaining('Conflicting indexOn declarations for "/jobs"'),
      }),
    ]);
  });

  test('check reports COMPILE_ERROR when duplicate path declarations resolve to the same normalized path', () => {
    const rules = defineRtdbRules({
      paths: {
        '/a': { read: deny(), write: deny(), children: { '/b': { read: deny(), write: deny() } } },
        '/a/b': { read: allow() },
      },
    });

    const check = rules.check();
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual([
      expect.objectContaining({
        path: '/',
        rule: 'ruleset',
        code: 'COMPILE_ERROR',
        message: expect.stringContaining('Duplicate ruleset path declaration for "/a/b"'),
      }),
    ]);
  });

  test('simulate normalises auth strings and data aliases', () => {
    const rules = defineRtdbRules({
      paths: {
        '/': { read: deny(), write: deny() },
        '/profiles/$uid': {
          write: all(pathOwnerOnly('$uid'), eq(dataVal('locked'), false), eq(newDataVal('owner'), 'alice')),
        },
      },
    });

    const result = rules.simulate({
      operation: 'write',
      path: '/profiles/alice',
      auth: 'alice',
      data: { profiles: { alice: { locked: false } } },
      newData: { owner: 'alice' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.pathVariableBindings).toEqual({ '$uid': 'alice' });
    }
  });

  test('simulate reports denied requests through the existing simulation result', () => {
    const rules = defineRtdbRules({
      paths: {
        '/profiles/$uid': { read: pathOwnerOnly('$uid') },
      },
    });

    const result = rules.simulate({
      operation: 'read',
      path: '/profiles/alice',
      auth: { uid: 'bob' },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(false);
  });

  test('simulate preserves auth.tenant and folds it into auth.token.firebase.tenant (CON-2a)', () => {
    const doc = defineRtdbRules({
      paths: {
        '/t': { read: expr("auth != null && auth.token.firebase.tenant == 'acme'") },
      },
    });

    const allowed = doc.simulate({
      operation: 'read',
      path: '/t',
      auth: { uid: 'u1', tenant: 'acme' },
    });
    expect(allowed.success).toBe(true);
    if (allowed.success) expect(allowed.data.allowed).toBe(true);

    const denied = doc.simulate({
      operation: 'read',
      path: '/t',
      auth: { uid: 'u1', tenant: 'other' },
    });
    expect(denied.success).toBe(true);
    if (denied.success) expect(denied.data.allowed).toBe(false);
  });

  test('simulate normalizes serverTimestamp() from pyric/rules to RTDB {".sv": "timestamp"} (CON-3)', () => {
    const doc = defineRtdbRules({
      paths: {
        '/posts/$id': {
          write: allow(),
          children: {
            createdAt: { validate: expr('newData.isNumber() && newData.val() === now') },
          },
        },
      },
    });

    const singleWrite = doc.simulate({
      operation: 'write',
      path: '/posts/p1',
      auth: 'u1',
      newData: { createdAt: serverTimestamp() },
    });
    expect(singleWrite.success).toBe(true);
    if (singleWrite.success) expect(singleWrite.data.allowed).toBe(true);

    const multiUpdate = doc.simulate({
      operation: 'write',
      path: '/posts/p1/createdAt',
      auth: 'u1',
      newData: serverTimestamp(),
      updates: [{ path: '/posts/p1/createdAt', value: serverTimestamp() }],
    });
    expect(multiUpdate.success).toBe(true);
    if (multiUpdate.success) expect(multiUpdate.data.allowed).toBe(true);
  });

  test('check and rtdbRules(doc).lint() include structural findings on defineRtdbRules documents (FUZ-5)', () => {
    const doc = defineRtdbRules({
      paths: {
        '/a/$x': { read: allow() },
        '/a/$y': { read: allow() },
      },
    });

    const check = doc.check();
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual([
      {
        path: '/a',
        rule: 'ruleset',
        code: 'MULTIPLE_WILDCARDS',
        message: "Cannot have multiple default rules ('$x' and '$y').",
      },
    ]);

    const issues = rtdbRules(doc).lint();
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'MULTIPLE_WILDCARDS',
        severity: 'error',
        message: "Cannot have multiple default rules ('$x' and '$y').",
      }),
    );
  });

  test('low-level ruleset stays available', () => {
    const compiled = ruleset({ '/': { read: deny() } });
    expect(compiled.read?.raw).toBe('false');
  });

  test('simulate projects equalTo into query.startAt and query.endAt (QRY-1)', () => {
    const doc = defineRtdbRules({
      paths: {
        '/items': {
          read: expr("query.orderByChild == 'status' && query.startAt == 'open' && query.endAt == 'open'"),
        },
      },
    });
    const res = doc.simulate({
      operation: 'read',
      path: '/items',
      auth: { uid: 'u1' },
      query: { orderByChild: 'status', equalTo: 'open' },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.allowed).toBe(true);
    }
  });

  test('simulate rejects impossible queries with INVALID_INPUT (QRY-3a / QRY-3b)', () => {
    const doc = defineRtdbRules({
      paths: {
        '/items': {
          read: expr('query.limitToFirst <= 10 && query.limitToLast <= 10'),
        },
      },
    });

    for (const badQuery of [
      { limitToFirst: 5, limitToLast: 5 },
      { limitToFirst: -5 },
      { limitToLast: 0 },
      { limitToFirst: 1.5 },
      { orderByKey: true, orderByValue: true },
      { orderByChild: 'status', startAt: 'a', equalTo: 'b' },
      { orderByChild: 'status', endAt: 'z', equalTo: 'b' },
      { orderByChild: '' },
      { orderByChild: '///' },
    ]) {
      const res = doc.simulate({
        operation: 'read',
        path: '/items',
        auth: { uid: 'u1' },
        query: badQuery,
      });
      expect(res).toEqual({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: expect.any(String),
          recoverable: true,
        },
      });
    }
  });
});

describe('defineRtdbRules unknown keys (CS-3)', () => {
  test('throws where the definition is written, not when it is first compiled', () => {
    expect(() => defineRtdbRules({ paths: { '/a': { valdiate: 'true' } as never } })).toThrow(/valdiate.*validate/);
    expect(() => defineRtdbRules({ paths: { '/a': { children: { '/b': { raed: 'true' } } } as never } })).toThrow(/raed.*read/);
  });
});
