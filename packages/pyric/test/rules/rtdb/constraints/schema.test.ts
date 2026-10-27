import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { schemaRules } from '../../../../src/rules/rtdb/constraints/schema.js';
import { allow, expr } from '../../../../src/rules/rtdb/constraints/compose.js';
import { defineRtdbRules } from '../../../../src/rules/rtdb/constraints/document.js';
import { rtdbRules } from '../../../../src/rules/index.js';

describe('schemaRules', () => {
  test('z.string() → isString', () => {
    const result = schemaRules(z.object({ name: z.string() }));
    expect(result.children.name.validate).toBe('newData.isString()');
  });

  test('z.number() → isNumber', () => {
    const result = schemaRules(z.object({ age: z.number() }));
    expect(result.children.age.validate).toBe('newData.isNumber()');
  });

  test('z.boolean() → isBoolean', () => {
    const result = schemaRules(z.object({ active: z.boolean() }));
    expect(result.children.active.validate).toBe('newData.isBoolean()');
  });

  test('z.enum() → val() == comparisons', () => {
    const result = schemaRules(z.object({ role: z.enum(['user', 'admin']) }));
    expect(result.children.role.validate).toBe("newData.val() == 'user' || newData.val() == 'admin'");
  });

  test('z.literal(string) → val() == literal', () => {
    const result = schemaRules(z.object({ type: z.literal('post') }));
    expect(result.children.type.validate).toBe("newData.val() == 'post'");
  });

  test('z.literal(number) → val() == number', () => {
    const result = schemaRules(z.object({ version: z.literal(1) }));
    expect(result.children.version.validate).toBe('newData.val() == 1');
  });

  test('z.literal(boolean) → val() == boolean', () => {
    const result = schemaRules(z.object({ enabled: z.literal(true) }));
    expect(result.children.enabled.validate).toBe('newData.val() == true');
  });

  test('required fields generate parent validate with hasChild', () => {
    const result = schemaRules(z.object({ name: z.string(), email: z.string() }));
    expect(result.validate).toContain('newData.hasChildren()');
    expect(result.validate).toContain("newData.hasChild('name')");
    expect(result.validate).toContain("newData.hasChild('email')");
  });

  test('optional fields excluded from required list', () => {
    const result = schemaRules(z.object({
      name: z.string(),
      bio: z.string().optional(),
    }));
    expect(result.validate).toContain("newData.hasChild('name')");
    expect(result.validate).not.toContain("newData.hasChild('bio')");
    // But bio still gets a child validate rule
    expect(result.children.bio.validate).toBe('newData.isString()');
  });

  test('nested z.object() produces nested children', () => {
    const result = schemaRules(z.object({
      address: z.object({
        city: z.string(),
        zip: z.string(),
      }),
    }));
    expect(result.children.address.validate).toContain('newData.hasChildren()');
    expect(result.children.address.children).toBeDefined();
    expect(result.children.address.children!.city.validate).toBe('newData.isString()');
    expect(result.children.address.children!.zip.validate).toBe('newData.isString()');
  });

  test('z.union of primitives → OR of type checks', () => {
    const result = schemaRules(z.object({
      value: z.union([z.string(), z.number()]),
    }));
    expect(result.children.value.validate).toBe('newData.isString() || newData.isNumber()');
  });

  test('fieldConstraints merge with schema via all()', () => {
    const result = schemaRules(
      z.object({ author: z.string() }),
      { author: [expr('newData.val() == auth.uid')] },
    );
    expect(result.children.author.validate).toBe('newData.isString() && newData.val() == auth.uid');
  });

  test('fieldConstraints with multiple constraints', () => {
    const result = schemaRules(
      z.object({ createdAt: z.number() }),
      { createdAt: [expr('!data.exists() || newData.val() == data.val()'), expr('newData.val() <= now')] },
    );
    expect(result.children.createdAt.validate).toContain('newData.isNumber()');
    expect(result.children.createdAt.validate).toContain('!data.exists() || newData.val() == data.val()');
    expect(result.children.createdAt.validate).toContain('newData.val() <= now');
  });

  test('unsupported z.array() throws', () => {
    expect(() => schemaRules(z.object({ tags: z.array(z.string()) }))).toThrow('Unsupported');
  });

  test('unsupported z.date() throws', () => {
    expect(() => schemaRules(z.object({ date: z.date() }))).toThrow('Unsupported');
  });

  test('empty object → just hasChildren()', () => {
    const result = schemaRules(z.object({}));
    expect(result.validate).toBe('newData.hasChildren()');
    expect(Object.keys(result.children)).toHaveLength(0);
  });

  test('compiles z.string() .min/.max/.length/.regex/.email refinements and enforces them in simulate (CON-1 / FUZ-7)', () => {
    const schema = z.object({
      name: z.string().min(3).max(5),
      code: z.string().length(4),
      handle: z.string().regex(/^[a-z0-9_]+$/i),
      email: z.string().email(),
    });
    const result = schemaRules(schema);
    expect(result.children.name.validate).toBe(
      'newData.isString() && newData.val().length >= 3 && newData.val().length <= 5',
    );
    expect(result.children.code.validate).toBe(
      'newData.isString() && newData.val().length == 4',
    );
    expect(result.children.handle.validate).toBe(
      'newData.isString() && newData.val().matches(/^[a-z0-9_]+$/i)',
    );
    expect(result.children.email.validate).toContain('newData.isString() && newData.val().matches(');

    const engine = rtdbRules(
      defineRtdbRules({
        paths: {
          '/users/$uid': { write: allow(), schema },
        },
      }),
    );
    const report = engine.simulate([
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'alice', code: 'ABCD', handle: 'Alice_1', email: 'alice@example.com' },
        expectation: 'ALLOW',
      },
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'al', code: 'ABCD', handle: 'Alice_1', email: 'alice@example.com' },
        expectation: 'DENY',
      },
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'alice', code: 'ABC', handle: 'Alice_1', email: 'alice@example.com' },
        expectation: 'DENY',
      },
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'alice', code: 'ABCD', handle: 'bad-handle!', email: 'alice@example.com' },
        expectation: 'DENY',
      },
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'alice', code: 'ABCD', handle: 'Alice_1', email: 'not-an-email' },
        expectation: 'DENY',
      },
    ]);
    expect(report.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY', 'DENY', 'DENY', 'DENY']);
  });

  test('compiles z.number() .int/.min/.max/.gt/.lt refinements and enforces them in simulate (CON-1 / FUZ-7)', () => {
    const schema = z.object({
      age: z.number().int().min(18).max(120),
      score: z.number().gt(0).lt(10),
    });
    const result = schemaRules(schema);
    expect(result.children.age.validate).toBe(
      'newData.isNumber() && newData.val() % 1 == 0 && newData.val() >= 18 && newData.val() <= 120',
    );
    expect(result.children.score.validate).toBe(
      'newData.isNumber() && newData.val() > 0 && newData.val() < 10',
    );

    const engine = rtdbRules(
      defineRtdbRules({
        paths: {
          '/players/$uid': { write: allow(), schema },
        },
      }),
    );
    const report = engine.simulate([
      {
        operation: 'write',
        path: '/players/u1',
        auth: { uid: 'u1', token: {} },
        newData: { age: 18, score: 5 },
        expectation: 'ALLOW',
      },
      {
        operation: 'write',
        path: '/players/u1',
        auth: { uid: 'u1', token: {} },
        newData: { age: 18.5, score: 5 },
        expectation: 'DENY',
      },
      {
        operation: 'write',
        path: '/players/u1',
        auth: { uid: 'u1', token: {} },
        newData: { age: 17, score: 5 },
        expectation: 'DENY',
      },
      {
        operation: 'write',
        path: '/players/u1',
        auth: { uid: 'u1', token: {} },
        newData: { age: 18, score: 0 },
        expectation: 'DENY',
      },
    ]);
    expect(report.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY', 'DENY', 'DENY']);
  });

  test('compiles z.object().strict() with $other: false and denies unknown keys in simulate (CON-1)', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schemaRules(schema);
    expect(result.children.$other?.validate).toBe('false');

    const engine = rtdbRules(
      defineRtdbRules({
        paths: {
          '/users/$uid': { write: allow(), schema },
        },
      }),
    );
    const report = engine.simulate([
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'alice' },
        expectation: 'ALLOW',
      },
      {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        newData: { name: 'alice', extra: true },
        expectation: 'DENY',
      },
    ]);
    expect(report.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY']);
  });

  test('refuses a Zod regex RTDB reads differently from JavaScript or refuses at deploy (#1247 SP-2b, SP-1, SP-2a)', () => {
    const refused: Array<[RegExp, RegExp]> = [
      [/^(?=.*[0-9]).+$/, /\(\?/],
      [/^(?!admin).*$/, /\(\?/],
      [/^(?:a|b)$/, /\(\?/],
      [/^(a)\1$/, /backreference/],
      [/\bcat\b/, /word boundary/],
      [/^[a-z]+?$/, /lazy quantifier/],
      [/^a\tb$/, /escape \\t/],
      [/^\u0041$/, /escape \\u/],
      [/^red$|^blue$/, /unescaped \^/],
    ];
    for (const [regex, reason] of refused) {
      const build = () => schemaRules(z.object({ tag: z.string().regex(regex) }));
      expect(build, regex.source).toThrow(/Unsupported Zod regex on field "tag"/);
      expect(build, regex.source).toThrow(reason);
    }
    const result = schemaRules(z.object({ tag: z.string().regex(/^[\w-]+\.\d{2,3}$/) }));
    expect(result.children.tag.validate).toBe('newData.isString() && newData.val().matches(/^[\\w-]+\\.\\d{2,3}$/)');
  });

  test('emits . unchanged, so the rule accepts a newline the Zod schema refuses (#1247 SP-8, known gap)', () => {
    const schema = z.object({ code: z.string().regex(/^a.b$/) });
    expect(schemaRules(schema).children.code.validate).toBe('newData.isString() && newData.val().matches(/^a.b$/)');
    expect(schema.safeParse({ code: 'a\nb' }).success).toBe(false);
    const engine = rtdbRules(defineRtdbRules({ paths: { '/items/$id': { write: allow(), schema } } }));
    const report = engine.simulate([
      { operation: 'write', path: '/items/i1', auth: null, newData: { code: 'a\nb' }, expectation: 'ALLOW' },
    ]);
    // Production's . matches \n (r47 "dot does not match a newline": ALLOW), and
    // the dialect has no "any character but a newline", so the gap is pinned here.
    expect(report.cases.map((c) => c.decision)).toEqual(['ALLOW']);
  });

  test('rejects unsupported Zod refinements, invalid z.literal values, and unknown fieldConstraints keys (CON-1 / FUZ-7)', () => {
    expect(() => schemaRules(z.object({ id: z.string().uuid() }))).toThrow(/Unsupported/);
    expect(() => schemaRules(z.object({ tag: z.string().regex(/a/g) }))).toThrow(/Unsupported/);
    expect(() => schemaRules(z.object({ bad: z.literal(undefined) }))).toThrow(/no literal for undefined/);
    expect(() => schemaRules(z.object({ bad: z.literal(Number.NaN) }))).toThrow(/no literal for NaN/);
    expect(() =>
      schemaRules(z.object({ unionWithObject: z.union([z.string(), z.object({ a: z.string() })]) })),
    ).toThrow(/Unsupported Zod type.*ZodObject/);
    expect(() =>
      schemaRules(z.object({ name: z.string() }), { missingKey: [expr("newData.val() == 'ok'")] }),
    ).toThrow(/missingKey/);
  });

  test('preserves fieldConstraints on a nested z.object field (FUZ-7)', () => {
    const result = schemaRules(
      z.object({
        meta: z.object({ title: z.string() }),
      }),
      {
        meta: [expr("newData.child('title').val() == 'ok'")],
      },
    );
    expect(result.children.meta.validate).toBe(
      "newData.hasChildren() && newData.hasChild('title') && newData.child('title').val() == 'ok'",
    );
    expect(result.children.meta.children?.title.validate).toBe('newData.isString()');
  });
});
