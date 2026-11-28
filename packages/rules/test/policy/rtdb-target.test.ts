// Unit and RTDB-simulator parity tests for packages/rules/src/policy/rtdb.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firestoreGrammar, firestoreSemantics } from '../../src/grammar/FirestoreParser.js';
import type { Expression, FunctionDef } from '../../src/grammar/FirestoreAST.js';
import { evaluate, evaluateBinding } from '../../src/simulator/evaluator.js';
import { ExpressionBudget } from '../../src/simulator/expression-budget.js';
import { rtdbRules } from '../../src/api/rtdb.js';
import { parseRtdbExpressionTree } from '../../src/rtdb/grammar/expression-tree.js';
import {
  emitRtdbFunctionPredicate,
  hasRequiredConjunct,
  lowerRtdbExpression,
  type RtdbBindings,
} from '../../src/policy/rtdb.js';
import { createRng } from './fuzz-prng.js';

function parseExpr(source: string): Expression {
  const match = firestoreGrammar.match(source, 'Expr');
  if (match.failed()) throw new Error(match.message);
  return firestoreSemantics(match).toAST() as Expression;
}

function parseFn(source: string): FunctionDef {
  const match = firestoreGrammar.match(source, 'FunctionDef');
  if (match.failed()) throw new Error(match.message);
  return firestoreSemantics(match).toAST() as FunctionDef;
}

function evalInterpreter(expr: Expression, scope: Record<string, unknown>): 'ALLOW' | 'DENY' {
  try {
    return evaluate(expr, {}, scope) === true ? 'ALLOW' : 'DENY';
  } catch {
    return 'DENY';
  }
}

function evalRtdb(predicate: string, data: unknown, newData: unknown): 'ALLOW' | 'DENY' {
  // In Firebase RTDB, writing an empty object `{}` deletes the node and skips `.validate`.
  // Attach a sibling sentinel on empty object writes so `.validate` executes for missing-key checks.
  const rtdbNewData = newData && typeof newData === 'object' && !Array.isArray(newData) && Object.keys(newData).length === 0
    ? { _keep: true }
    : newData;
  const rules = rtdbRules({ rules: { item: { '.write': 'newData.exists()', '.validate': predicate } } });
  const [row] = rules.simulate([
    { path: '/item', operation: 'write', expectation: 'ALLOW', data: { item: data }, newData: rtdbNewData },
  ]).cases;
  expect(row?.unsupported, `unsupported for ${predicate}: ${row?.reason}`).toBe(false);
  return row!.decision as 'ALLOW' | 'DENY';
}

describe('unified RTDB target (policy/rtdb.ts)', () => {
  test('lowers exact safe-integer increment and matches RTDB simulator', () => {
    const expr = parseExpr(
      'before.n is int && before.n >= 0 && before.n <= 9007199254740991'
      + ' && after.n is int && after.n >= 0 && after.n <= 9007199254740991'
      + ' && after.n == before.n + 1',
    );
    const res = lowerRtdbExpression(expr, { 'before.n': 'data', 'after.n': 'newData' }, { checkTiming: true });
    expect(res.problems).toEqual([]);
    expect(res.predicate).toBeDefined();
    expect(evalRtdb(res.predicate!, 5, 6)).toBe('ALLOW');
    expect(evalRtdb(res.predicate!, 0, 1)).toBe('ALLOW');
    expect(evalRtdb(res.predicate!, 5, 7)).toBe('DENY');
    expect(evalRtdb(res.predicate!, 5.5, 6.5)).toBe('DENY');
    expect(evalRtdb(res.predicate!, -1, 0)).toBe('DENY');
    expect(evalRtdb(res.predicate!, '5', 6)).toBe('DENY');
    expect(evalRtdb(res.predicate!, null, 1)).toBe('DENY');
  });

  test('supports numeric, boolean, string, .size(), and root null comparisons with parity', () => {
    const bindings: RtdbBindings = {
      before: { snapshot: 'data' },
      after: { snapshot: 'newData' },
    };
    const cases: Array<{ expr: string; data: unknown; newData: unknown }> = [
      { expr: 'after.name is string && after.name.size() >= 2 && after.name.size() <= 5', data: {}, newData: { name: 'abc' } },
      { expr: 'after.name is string && after.name.size() >= 2 && after.name.size() <= 5', data: {}, newData: { name: 'a' } },
      { expr: 'after.name is string && after.name.size() >= 2 && after.name.size() <= 5', data: {}, newData: { name: 123 } },
      { expr: 'after.active is bool && after.active && !before.active', data: { active: false }, newData: { active: true } },
      { expr: 'after.active is bool && after.active && !before.active', data: { active: true }, newData: { active: true } },
      { expr: 'after.active is bool && after.active && !before.active', data: { active: 'no' }, newData: { active: true } },
      { expr: 'after.tag == before.tag + "_v2"', data: { tag: 'app' }, newData: { tag: 'app_v2' } },
      { expr: 'after.tag == before.tag + "_v2"', data: { tag: 1 }, newData: { tag: '1_v2' } },
      { expr: 'after.code >= "a" && after.code < "z"', data: {}, newData: { code: 'm' } },
      { expr: 'after.code >= "a" && after.code < "z"', data: {}, newData: { code: 5 } },
      { expr: 'after.val != null && after.val != "banned"', data: {}, newData: { val: 'ok' } },
      { expr: 'after.val != null && after.val != "banned"', data: {}, newData: { val: 'banned' } },
      { expr: 'after.val != null && after.val != "banned"', data: {}, newData: {} },
    ];
    for (const c of cases) {
      const ast = parseExpr(c.expr);
      const lowered = lowerRtdbExpression(ast, bindings, { checkTiming: true });
      expect(lowered.problems, c.expr).toEqual([]);
      const expected = evalInterpreter(ast, { before: c.data, after: c.newData });
      const actual = evalRtdb(lowered.predicate!, c.data, c.newData);
      expect(actual, c.expr + ' ' + JSON.stringify(c.newData)).toBe(expected);
    }

    // Root-level null comparison (e.g. create requires before == null)
    const createOnly = parseExpr('before == null && after is int && after == 0');
    const loweredCreate = lowerRtdbExpression(createOnly, { before: 'data', after: 'newData' }, { checkTiming: true });
    expect(loweredCreate.problems).toEqual([]);
    expect(evalRtdb(loweredCreate.predicate!, null, 0)).toBe('ALLOW');
    expect(evalRtdb(loweredCreate.predicate!, 1, 0)).toBe('DENY');
  });

  test('fixes guard-hoisting bugs: short-circuit ||, unused let, ternary, and Kleene negation', () => {
    const bindings: RtdbBindings = { a: { snapshot: 'data' }, b: { snapshot: 'newData' } };

    // 1. Short-circuit || and error absorption: a.x == 1 || b.x == 2 with missing b.x or missing a.x
    const orFn = parseFn('function f(a, b) { return a.x == 1 || b.x == 2; }');
    const orPred = emitRtdbFunctionPredicate(orFn, bindings, 'any');
    expect(evalRtdb(orPred, { x: 1 }, {})).toBe('ALLOW');
    expect(evalRtdb(orPred, {}, { x: 2 })).toBe('ALLOW');
    expect(evalRtdb(orPred, { x: 9 }, {})).toBe('DENY');
    expect(evalRtdb(orPred, { x: '1' }, { x: 3 })).toBe('DENY');

    // 2. Unused let must not poison evaluation with hoisted guards
    const unusedLetFn = parseFn('function f(a, b) { let dead = b.missing + 1; return a.x == 1; }');
    const unusedPred = emitRtdbFunctionPredicate(unusedLetFn, bindings, 'number');
    expect(evalRtdb(unusedPred, { x: 1 }, {})).toBe('ALLOW');

    // 3. Negated comparisons and De Morgan under missing/wrong-type fields (never fail open!)
    const negExprs = [
      '!(a.x < 5)',
      '!(a.x == 1 || b.x == 2)',
      '!(a.x == 1 && b.x == 2)',
      '!(a.flag)',
      'a.flag ? b.x > 0 : b.y > 0',
      '((a.flag ? b.x : b.y) + 1) > 5',
    ];
    const payloads = [
      { a: { x: 1, flag: true }, b: { x: 2, y: 10 } },
      { a: { x: 10, flag: false }, b: { x: -1, y: 10 } },
      { a: { flag: true }, b: { x: 5 } },
      { a: { flag: false }, b: { y: 5 } },
      { a: { flag: 'bad', x: 'str' }, b: { x: 5, y: 5 } },
      { a: {}, b: {} },
      { a: { x: 1 }, b: {} },
      { a: {}, b: { x: 2 } },
      { a: { x: 2 }, b: {} },
    ];
    for (const src of negExprs) {
      const ast = parseExpr(src);
      const lowered = lowerRtdbExpression(ast, bindings);
      expect(lowered.problems, src).toEqual([]);
      for (const p of payloads) {
        const expected = evalInterpreter(ast, p);
        const actual = evalRtdb(lowered.predicate!, p.a, p.b);
        expect(actual, `${src} on ${JSON.stringify(p)}`).toBe(expected);
      }
    }
  });

  test('lowers real Air Hockey frame.policy and reaches-seven.policy cleanly within size cap', () => {
    const oracleAdapters = join(import.meta.dir, '../../../../experiments/policy-oracle/adapters');
    const frameSrc = readFileSync(join(oracleAdapters, 'air-hockey/v1/frame.policy'), 'utf8');
    const winSrc = readFileSync(join(oracleAdapters, 'air-hockey-match-win/v1/reaches-seven.policy'), 'utf8');
    const framePred = emitRtdbFunctionPredicate(parseFn(frameSrc), {
      last: { snapshot: 'data', path: 'puck' },
      next: { snapshot: 'newData', path: 'puck' },
      oldScore: { snapshot: 'data', parent: true, path: 'score' },
      score: { snapshot: 'newData', parent: true, path: 'score' },
    }, 'number');
    expect(framePred.length).toBeLessThan(16384);
    expect(parseRtdbExpressionTree(framePred).ok).toBe(true);

    const winPred = emitRtdbFunctionPredicate(parseFn(winSrc), {
      before: { snapshot: 'data', path: 'score' },
      after: { snapshot: 'newData', path: 'score' },
    }, 'number');
    expect(parseRtdbExpressionTree(winPred).ok).toBe(true);
    const rules = rtdbRules({ rules: { m: { '.write': true, '.validate': winPred } } });
    expect(rules.simulate([{ path: '/m', operation: 'write', expectation: 'ALLOW',
      data: { m: { score: { host: 6, guest: 5 } } }, newData: { score: { host: 7, guest: 5 } } }]).cases[0]?.decision).toBe('ALLOW');
    expect(rules.simulate([{ path: '/m', operation: 'write', expectation: 'DENY',
      data: { m: { score: { host: 5, guest: 5 } } }, newData: { score: { host: 6, guest: 5 } } }]).cases[0]?.decision).toBe('DENY');
  });

  test('refuses unsafe operators, injection, wrong timing, and fail-open disjunction placement', () => {
    const bindings: RtdbBindings = { before: { snapshot: 'data' }, after: { snapshot: 'newData' } };
    expect(lowerRtdbExpression(parseExpr('after.x / 2 == 1'), bindings).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('after.x is float'), bindings).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('after.x == null'), bindings).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('!(after.x != null)'), bindings).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('after.x != null ? true : true'), bindings).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('after.x + "s" == "1s"'), { after: { snapshot: 'newData', type: 'number' } }).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('after.x == 1'), { after: { snapshot: 'data' } }, { checkTiming: true }).problems[0]).toContain('Wrong snapshot');
    expect(lowerRtdbExpression(parseExpr('after.x == 1'), { after: { snapshot: 'newData', path: 'x") || true' } }).predicate).toBeUndefined();

    // Strict conjunctive placement refuses disjunction/ternary bypasses
    const predTree = parseRtdbExpressionTree('newData.isNumber()');
    expect(predTree.ok).toBe(true);
    const wanted = JSON.stringify(predTree.ok ? predTree.tree : null);
    const bypassOr = parseRtdbExpressionTree('true || newData.isNumber()');
    const bypassTern = parseRtdbExpressionTree('auth != null ? true : newData.isNumber()');
    const requiredAnd = parseRtdbExpressionTree('auth != null && newData.isNumber()');
    expect(bypassOr.ok && hasRequiredConjunct(bypassOr.tree, wanted)).toBe(false);
    expect(bypassTern.ok && hasRequiredConjunct(bypassTern.tree, wanted)).toBe(false);
    expect(requiredAnd.ok && hasRequiredConjunct(requiredAnd.tree, wanted)).toBe(true);
  });

  test('pins red-team regressions: boolean ==/!=, negated boolean lets, >2^53 arithmetic, and non-constant %', () => {
    const bindings: RtdbBindings = { after: { snapshot: 'newData' } };
    // 1. Boolean == / != Kleene biconditional must not fail open on missing/wrong-type fields
    for (const [src, after] of [
      ['(after.x > 0 || after.y > 0) == false', {}],
      ['(after.x > 0 || after.y > 0) == false', { x: 'bad', y: -1 }],
      ['(after.x < after.y) == false', {}],
      ['(after.x > 0 || false) == (after.y > 0 || false)', {}],
      ['(after.x > 0 || false) == (after.y > 0 || false)', { x: 1, y: 2 }],
      ['(after.x > 0 || false) == (after.y > 0 || false)', { x: -1, y: -2 }],
      ['(after.x > 0 || false) == (after.y > 0 || false)', { x: 1, y: -2 }],
      ['after.flag == (after.x > 0)', {}],
      ['after.flag == (after.x > 0)', { flag: false, x: -1 }],
      ['after.flag != (after.x > 0)', { flag: 123, x: 1 }],
    ] as const) {
      const ast = parseExpr(src);
      const lowered = lowerRtdbExpression(ast, bindings);
      expect(lowered.predicate, src).toBeDefined();
      expect(evalRtdb(lowered.predicate!, {}, after), `${src} on ${JSON.stringify(after)}`)
        .toBe(evalInterpreter(ast, { after }));
    }

    // 2. Boolean let bindings must preserve dual polarity under ! and ?:
    for (const [fnSrc, after] of [
      ['function f(after) { let ok = after.x > 0 || after.y > 0; return !ok; }', {}],
      ['function f(after) { let ok = after.x > 0 || after.y > 0; return !ok; }', { x: -1, y: -2 }],
      ['function f(after) { let ok = after.x > 0 || after.y > 0; return !ok; }', { x: 1, y: -2 }],
      ['function f(after) { let lt = after.x < after.y; return !lt; }', {}],
      ['function f(after) { let lt = after.x < after.y; return !lt; }', { x: 5, y: 2 }],
    ] as const) {
      const pred = emitRtdbFunctionPredicate(parseFn(fnSrc), { after: { snapshot: 'newData', type: 'any' } }, 'any');
      const fn = parseFn(fnSrc);
      const expected = (() => {
        try {
          const scope: Record<string, unknown> = { after };
          for (const l of fn.lets) scope[l.name] = evaluateBinding(l.value, { expressionBudget: new ExpressionBudget(() => new Error('limit'), 8192) }, scope);
          return evaluate(fn.body, { expressionBudget: new ExpressionBudget(() => new Error('limit'), 8192) }, scope) === true ? 'ALLOW' : 'DENY';
        } catch { return 'DENY'; }
      })();
      expect(evalRtdb(pred, {}, after), `${fnSrc} on ${JSON.stringify(after)}`).toBe(expected);
    }

    // 3. Arithmetic past 2^53 / int64 overflow must never fail open
    for (const src of [
      'after.x + 2 == after.x + 1',
      'after.x * after.x > 0',
      '!(after.x * after.x > 0)',
    ]) {
      const ast = parseExpr(src);
      const lowered = lowerRtdbExpression(ast, bindings);
      expect(lowered.predicate, src).toBeDefined();
      expect(evalRtdb(lowered.predicate!, {}, { x: 9007199254740991 }), src).toBe('DENY');
    }

    // 4. Non-constant % divisor refused (float % 0 yields NaN while int % 0 errors); constant non-zero % allowed
    expect(lowerRtdbExpression(parseExpr('!(after.x % after.y == 0)'), bindings).predicate).toBeUndefined();
    expect(lowerRtdbExpression(parseExpr('after.x % 0 == 0'), bindings).predicate).toBeUndefined();
    const constMod = lowerRtdbExpression(parseExpr('after.x % 2 == 0'), bindings);
    expect(constMod.predicate).toBeDefined();
    expect(evalRtdb(constMod.predicate!, {}, { x: 4 })).toBe('ALLOW');
    expect(evalRtdb(constMod.predicate!, {}, { x: 3 })).toBe('DENY');
  });

  test('seeded differential parity over 200 RTDB expressions and edge values', () => {
    const rng = createRng(0x27db0001);
    const bindings: RtdbBindings = { before: { snapshot: 'data' }, after: { snapshot: 'newData' } };
    const leafVals: readonly unknown[] = [0, 1, -1, 2, 7, 1.5, 'a', 'b', 'ab', true, false];

    function genAtom(): string {
      const kind = rng.int(0, 6);
      const side = rng.bool() ? 'before' : 'after';
      const key = rng.pick(['x', 'y', 's', 'flag']);
      switch (kind) {
        case 0: return `${side}.${key} == ${rng.pick(['0', '1', '-1', '2', '"a"', 'true', 'false'])}`;
        case 1: return `${side}.${key} != ${rng.pick(['0', '1', '"a"', 'true'])}`;
        case 2: return `${side}.${key} ${rng.pick(['<', '<=', '>', '>='])} ${rng.pick(['0', '1', '2', '-1'])}`;
        case 3: return `${side}.x ${rng.pick(['+', '-', '*'])} ${rng.pick(['1', '2', '-1'])} == ${rng.pick(['0', '1', '2', '3'])}`;
        case 4: return `${side}.${key} is ${rng.pick(['int', 'number', 'string', 'bool'])}`;
        case 5: return `${side}.${key} != null`;
        default: return `${side}.s.size() >= ${rng.int(0, 2)}`;
      }
    }

    function genBool(depth: number): string {
      if (depth <= 0) return genAtom();
      const shape = rng.int(0, 4);
      if (shape === 0) return `(${genBool(depth - 1)} && ${genBool(depth - 1)})`;
      if (shape === 1) return `(${genBool(depth - 1)} || ${genBool(depth - 1)})`;
      if (shape === 2) return `!(${genBool(depth - 1)})`;
      if (shape === 3) return `(${genBool(depth - 1)} ? ${genBool(depth - 1)} : ${genBool(depth - 1)})`;
      return genAtom();
    }

    function genObj(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const k of ['x', 'y', 's', 'flag']) {
        if (rng.bool(0.75)) out[k] = rng.pick(leafVals);
      }
      return out;
    }

    let loweredCount = 0;
    for (let i = 0; i < 200; i++) {
      const src = genBool(rng.int(0, 2));
      const ast = parseExpr(src);
      const res = lowerRtdbExpression(ast, bindings, { checkTiming: true });
      if (!res.predicate) continue;
      loweredCount++;
      const before = genObj();
      const after = genObj();
      const expected = evalInterpreter(ast, { before, after });
      const actual = evalRtdb(res.predicate, before, after);
      expect(actual, `case #${i}: ${src} | before=${JSON.stringify(before)} after=${JSON.stringify(after)} | rtdb=${res.predicate}`).toBe(expected);
    }
    expect(loweredCount).toBeGreaterThan(120);
  }, 20000);
});
