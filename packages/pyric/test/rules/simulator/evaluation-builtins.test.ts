import { describe, expect, test } from 'bun:test';
import { evaluateFunctionCall } from '../../../src/rules/simulator/evaluation-builtins.js';
import type { SimulationContext } from '../../../src/rules/simulator/evaluation-context.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const sim = new SimulateFirestoreRulesHandler();

function rules(body: string, outerFns = ''): string {
  return `rules_version = '2';
service cloud.firestore {
  ${outerFns}
  match /databases/{database}/documents {
    ${body}
  }
}`;
}

function decisionOf(ruleset: string, tc: Omit<TestCase, 'description' | 'expectation'>): string {
  const res = sim.simulate(ruleset, [{ description: 'case', expectation: 'ALLOW', ...tc }]);
  if (!res.success) return `ERROR:${res.error.code}`;
  return res.data.results[0]?.decision ?? 'NONE';
}

describe('evaluation built-ins', () => {
  test('converts a strict numeric string with int()', () => {
    const literal = { type: 'literal' as const, value: '42', raw: "'42'" };
    expect(evaluateFunctionCall('int', [literal], {} as SimulationContext, {})).toBe(42);
  });

  test('FS-SIM-1 / FS-COV-1: enforces lexical scoping for path wildcards, caller variables, and sibling functions', () => {
    const outerWildcardLeak = rules(`
      match /a/{aId} {
        function readInnerB() { return bId == 'x'; }
        match /b/{bId} {
          allow read: if readInnerB();
        }
      }
    `);
    expect(decisionOf(outerWildcardLeak, { method: 'get', path: 'a/1/b/x' })).toBe('DENY');

    const callerLetLeak = rules(`
      function callee() { return x == 1; }
      function caller(a) {
        let x = a;
        return callee();
      }
      match /u/{id} { allow read: if caller(1); }
    `);
    expect(decisionOf(callerLetLeak, { method: 'get', path: 'u/1' })).toBe('DENY');

    const siblingFnLeak = rules(`
      match /a/{id} {
        function helper() { return true; }
        allow read: if helper();
      }
      match /b/{id} {
        function callSibling() { return helper(); }
        allow read: if callSibling();
      }
    `);
    expect(decisionOf(siblingFnLeak, { method: 'get', path: 'a/1' })).toBe('ALLOW');
    expect(decisionOf(siblingFnLeak, { method: 'get', path: 'b/1' })).toBe('DENY');

    const protoIdentLeak = rules(`
      match /u/{id} { allow read: if toString != null; }
    `);
    expect(decisionOf(protoIdentLeak, { method: 'get', path: 'u/1' })).toBe('DENY');
  });

  test('FS-SIM-2: rejects non-numeric operands on binary -, *, /, % and unary -', () => {
    expect(decisionOf(rules(`match /u/{id} { allow read: if 'abc' - 'a' != 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if 'a' * 2 != 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if '6' / '2' == 3; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if '6' % '2' == 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if -'5' == -5; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if -true == -1; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if (-'5' == -5) || true; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
  });

  test('FS-SIM-4: user-defined functions shadow global built-ins and enforce parameter arity', () => {
    const shadowedInt = rules(`
      function int(x) { return 42; }
      match /u/{id} { allow read: if int('99') == 42; }
    `);
    expect(decisionOf(shadowedInt, { method: 'get', path: 'u/1' })).toBe('ALLOW');

    const wrongArity = rules(`
      function pairFirst(a, b) { return a; }
      match /u/{id} { allow read: if pairFirst(1) == 1; }
    `);
    expect(decisionOf(wrongArity, { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(
      decisionOf(
        rules(`
          function pairFirst(a, b) { return a; }
          match /u/{id} { allow read: if pairFirst(1, 2, 3) == 1; }
        `),
        { method: 'get', path: 'u/1' },
      ),
    ).toBe('DENY');
  });

  test('FS-SIM-5: enforces Java Matcher replacement escapes and string method arities/types', () => {
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.replace('b', '\\\\$') == 'a$c'; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('ALLOW');
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.replace('(b)', '[$1]') == 'a[b]c'; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('ALLOW');
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.replace('b', '$&') == 'abc'; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('DENY');
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.lower(1) == 'abc'; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('DENY');
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.upper(1) == 'ABC'; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('DENY');
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.trim(1) == 'abc'; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('DENY');
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if 'abc'.split(1).size() > 0; }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('DENY');
  });

  test('FS-SIM-6 / FS-COV-4: enforces arity and argument types across built-ins, namespaces, and collection/wrapper methods', () => {
    expect(decisionOf(rules(`match /u/{id} { allow read: if int('1', 2) == 1; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if float('1.0', 2) == 1.0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if string(1, 2) == '1'; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if path(123) != null; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if math.abs(-1, 2) == 1; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if hashing.md5('a', 'b').size() == 16; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if [1, 2].toSet('x').size() == 2; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if ['a', 'b'].join(1) == 'a1b'; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if {'a': 1}.get('a', 0, 99) == 1; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if {'a': 1}.diff({'a': 1}, 'x').affectedKeys().size() == 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if {'a': 1}.diff('notamap').affectedKeys().size() >= 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if duration.value(1, 's', 2).seconds() == 1; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if duration.time(0, 0, 0, 0).nanos(1) == 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(2024, 1, 1).year(1) == 2024; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
  });

  test('FS-SIM-7 / FS-COV-3: Path.bind ignores prototype keys, wrapper errors absorb in unused let/params, and cross-type methods throw EvalError', () => {
    expect(
      decisionOf(rules(`match /u/{id} { allow read: if path('/a/$(toString)').bind({}) == path('/a/x'); }`), {
        method: 'get',
        path: 'u/1',
      }),
    ).toBe('DENY');

    const unusedLetAbsorbs = rules(`
      function ignore(unusedParam) {
        let unusedLet = path('/a/$(x)').bind('notamap');
        return true;
      }
      match /u/{id} { allow read: if ignore(latlng.value(0, 0).distance('bad')); }
    `);
    expect(decisionOf(unusedLetAbsorbs, { method: 'get', path: 'u/1' })).toBe('ALLOW');

    expect(decisionOf(rules(`match /u/{id} { allow read: if (1).size() == 1; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if (1).size() == 1 || true; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
    expect(decisionOf(rules(`match /u/{id} { allow read: if 'a'.keys().size() == 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if 'a'.keys().size() == 0 || true; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
    expect(decisionOf(rules(`match /u/{id} { allow read: if hashing.sha512('a') == hashing.md5('a') || true; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
  });

  test('FS-SIM-8: sliceAccess on null/undefined and non-scalar path interpolation throw EvalError', () => {
    expect(decisionOf(rules(`match /u/{id} { allow read: if null[0:1] == null; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if null[0:1] == null || true; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
    expect(
      decisionOf(
        rules(`match /u/{id} { allow create: if /databases/$(database)/documents/u/$(request.resource.data.bad) != null; }`),
        { method: 'create', path: 'u/1', data: { bad: { nested: 1 } } },
      ),
    ).toBe('DENY');
  });

  test('FS-SIM-9: request.resource is absent on get, list, and delete without wire payload, and present on delete with wire payload', () => {
    const r = rules(`
      match /u/{id} {
        allow get: if request.resource.data.secret == 'yes';
        allow delete: if request.resource.data.size() == 0;
      }
      match /delPayload/{id} {
        allow delete: if request.resource.data.x == 1;
      }
    `);
    expect(decisionOf(r, { method: 'get', path: 'u/1', resource: { secret: 'yes' } })).toBe('DENY');
    expect(decisionOf(r, { method: 'delete', path: 'u/1', resource: { secret: 'yes' } })).toBe('DENY');
    expect(decisionOf(r, { method: 'delete', path: 'delPayload/1', data: { x: 1 } })).toBe('ALLOW');
  });

  test('FS-SIM-10: timestamp.date validates calendar bounds and preserves 2-digit years', () => {
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(2025, 13, 1).month() > 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(2025, 0, 1).month() >= 0; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(2025, 2, 29).day() == 29; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(2024, 2, 29).day() == 29; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(50, 1, 1).year() == 50; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
    expect(decisionOf(rules(`match /u/{id} { allow read: if timestamp.date(50, 1, 1).year() == 1950; }`), { method: 'get', path: 'u/1' })).toBe('DENY');
  });

  test('FS-SIM-11: map literals require string keys at runtime', () => {
    const r = rules(`
      function m(k) { return {k: 'v'}; }
      match /u/{id} { allow read: if m(1)['1'] == 'v'; }
    `);
    expect(decisionOf(r, { method: 'get', path: 'u/1' })).toBe('DENY');
  });

  test('FS-SIM-12: get/exists/getAfter/existsAfter require a document Path argument', () => {
    expect(decisionOf(rules(`match /u/{id} { allow read: if !exists('/databases/(default)/documents/u/1'); }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if !exists(null); }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if !exists(/databases/$(database)/documents/u); }`), { method: 'get', path: 'u/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /u/{id} { allow read: if exists(/databases/$(database)/documents/u) || true; }`), { method: 'get', path: 'u/1' })).toBe('ALLOW');
  });

  test('FS-FUZ-5: Firestore string.matches evaluates nested quantifiers in linear time and supports RE2 inline flags and Unicode', () => {
    const start = performance.now();
    const d = decisionOf(
      rules(`match /u/{id} { allow create: if request.resource.data.s.matches('((a+)+)b'); }`),
      { method: 'create', path: 'u/1', data: { s: 'a'.repeat(28) } },
    );
    const elapsedMs = performance.now() - start;
    expect(d).toBe('DENY');
    expect(elapsedMs).toBeLessThan(100);

    expect(
      decisionOf(
        rules(`match /u/{id} { allow read: if 'ABC'.matches('(?i)abc') && '😀😀'.matches('😀+') && ']a]'.matches('[]a]+'); }`),
        { method: 'get', path: 'u/1' },
      ),
    ).toBe('ALLOW');
  });

  test('FS-FUZ-6: get/exists/getAfter/existsAfter on a path literal with a {capture} segment throws EvalError', () => {
    // Production (compile-probe-result.json & capture-probe2-result.json):
    // - `(/b/{id}) is path` -> ALLOW
    // - `!exists(/databases/$(database)/documents/b/{id})` -> DENY ("Function not found error: Name: [exists].")
    // - `exists(/databases/$(database)/documents/b/{id}) || true` -> ALLOW (error absorbed by || true)
    expect(decisionOf(rules(`match /a/{id} { allow read: if (/b/{id}) is path; }`), { method: 'get', path: 'a/1' })).toBe('ALLOW');
    expect(decisionOf(rules(`match /a/{id} { allow read: if !exists(/databases/$(database)/documents/b/{id}); }`), { method: 'get', path: 'a/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /a/{id} { allow read: if get(/databases/$(database)/documents/b/{id}).data != null; }`), { method: 'get', path: 'a/1' })).toBe('DENY');
    expect(decisionOf(rules(`match /a/{id} { allow write: if !existsAfter(/databases/$(database)/documents/b/{id}); }`), { method: 'create', path: 'a/1', data: {} })).toBe('DENY');
    expect(decisionOf(rules(`match /a/{id} { allow write: if getAfter(/databases/$(database)/documents/b/{id}).data != null; }`), { method: 'create', path: 'a/1', data: {} })).toBe('DENY');
    expect(decisionOf(rules(`match /a/{id} { allow read: if exists(/databases/$(database)/documents/b/{id}) || true; }`), { method: 'get', path: 'a/1' })).toBe('ALLOW');
  });
});
