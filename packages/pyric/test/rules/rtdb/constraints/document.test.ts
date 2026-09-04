import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  all,
  allow,
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
                '.write': '((auth != null) && (auth.uid == $messageId)) && (!data.exists() || newData.child("createdAt").val() == data.child("createdAt").val())',
                '.validate': '(newData.hasChildren()) && (newData.hasChild("author")) && (newData.hasChild("text")) && (newData.hasChild("createdAt"))',
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

  test('low-level ruleset stays available', () => {
    const compiled = ruleset({ '/': { read: deny() } });
    expect(compiled.read?.raw).toBe('false');
  });
});
