import { describe, expect, test } from 'bun:test';
import { compileRtdbRules, simulateRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';
import type { SimulationInput } from '../../../src/rules/rtdb/simulation/spec.js';
import { rtdbRules } from '../../../src/rules/api/rtdb.js';
import { explainCase } from '../../../src/rules/api/assert.js';

const alice = { uid: 'alice', token: {} };

function simulate(rules: Record<string, unknown>, input: Omit<SimulationInput, 'auth' | 'mockData'> & Partial<SimulationInput>) {
  const result = simulateRtdbRules(compileRtdbRules({ rules }), {
    auth: alice,
    mockData: {},
    ...input,
  });
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe('RTDB rule-by-rule evaluation trace', () => {
  test('a cascade where the ancestors deny and the leaf grants records each rule root first', () => {
    const rules = {
      '.read': 'false',
      rooms: {
        '.read': "auth.uid == 'admin'",
        $roomId: { '.read': 'auth.uid == $roomId' },
      },
    };
    const data = simulate(rules, { operation: 'read', path: '/rooms/alice' });
    expect(data.allowed).toBe(true);
    expect(data.trace).toEqual([
      { path: '/', kind: 'read', conditionText: 'false', verdict: 'DENY', pathVariableBindings: {} },
      { path: '/rooms', kind: 'read', conditionText: "auth.uid == 'admin'", verdict: 'DENY', pathVariableBindings: {} },
      {
        path: '/rooms/$roomId',
        kind: 'read',
        conditionText: 'auth.uid == $roomId',
        verdict: 'ALLOW',
        pathVariableBindings: { $roomId: 'alice' },
      },
    ]);
  });

  test('the cascade stops at the first grant, so no deeper rule appears', () => {
    const rules = { '.read': 'true', a: { '.read': 'false' } };
    const data = simulate(rules, { operation: 'read', path: '/a' });
    expect(data.allowed).toBe(true);
    expect(data.trace.map((e) => [e.path, e.verdict])).toEqual([['/', 'ALLOW']]);
  });

  test('a write records the grant, each .validate that passes, and the one that fails', () => {
    const rules = {
      items: {
        $id: {
          '.write': 'auth != null',
          '.validate': "newData.hasChildren(['a', 'b'])",
          a: { '.validate': 'newData.isString()' },
          b: { '.validate': 'newData.isNumber()' },
        },
      },
    };
    const data = simulate(rules, { operation: 'write', path: '/items/x', newData: { a: 'ok', b: 'nope' } });
    expect(data.allowed).toBe(false);
    expect(data.matchedPath).toBe('/items/$id/b');
    expect(data.trace).toEqual([
      { path: '/items/$id', kind: 'write', conditionText: 'auth != null', verdict: 'ALLOW', pathVariableBindings: { $id: 'x' } },
      {
        path: '/items/$id',
        kind: 'validate',
        conditionText: "newData.hasChildren(['a', 'b'])",
        verdict: 'ALLOW',
        pathVariableBindings: { $id: 'x' },
      },
      { path: '/items/$id/a', kind: 'validate', conditionText: 'newData.isString()', verdict: 'ALLOW', pathVariableBindings: { $id: 'x' } },
      { path: '/items/$id/b', kind: 'validate', conditionText: 'newData.isNumber()', verdict: 'DENY', pathVariableBindings: { $id: 'x' } },
    ]);
  });

  test('an allowed write records every .validate it checked', () => {
    const rules = { a: { '.write': 'true', '.validate': 'newData.isNumber()' } };
    const data = simulate(rules, { operation: 'write', path: '/a', newData: 5 });
    expect(data.allowed).toBe(true);
    expect(data.trace.map((e) => [e.kind, e.verdict])).toEqual([['write', 'ALLOW'], ['validate', 'ALLOW']]);
  });

  test('a rule that raises a runtime error is an ERROR entry carrying the message, and the cascade continues', () => {
    const rules = {
      w: { '.write': "newData.val().toUpperCase() == 'OK'", open: { '.write': 'auth != null' } },
    };
    const data = simulate(rules, { operation: 'write', path: '/w/open', newData: 5 });
    expect(data.allowed).toBe(true);
    expect(data.trace).toHaveLength(2);
    expect(data.trace[0].verdict).toBe('ERROR');
    expect(data.trace[0].path).toBe('/w');
    expect(data.trace[0].message).toContain('toUpperCase');
    expect(data.trace[1]).toEqual({
      path: '/w/open',
      kind: 'write',
      conditionText: 'auth != null',
      verdict: 'ALLOW',
      pathVariableBindings: {},
    });
  });

  test('a .validate that raises a runtime error is an ERROR entry and ends the walk', () => {
    const rules = { a: { '.write': 'true', '.validate': "newData.val().toUpperCase() == 'A'" } };
    const data = simulate(rules, { operation: 'write', path: '/a', newData: 5 });
    expect(data.allowed).toBe(false);
    const last = data.trace[data.trace.length - 1];
    expect(last.kind).toBe('validate');
    expect(last.verdict).toBe('ERROR');
    expect(last.message).toContain('toUpperCase');
  });

  test('an implicit deny has an empty trace and keeps the reason', () => {
    const data = simulate({ a: { '.write': 'true' } }, { operation: 'read', path: '/a' });
    expect(data.allowed).toBe(false);
    expect(data.trace).toEqual([]);
    expect(data.reason).toContain('denied by default');
  });

  test('a rule the simulator cannot evaluate is an UNSUPPORTED entry', () => {
    const data = simulate({ a: { '.read': 'data.val() ===' } }, { operation: 'read', path: '/a' });
    expect(data.unsupported).toBe(true);
    expect(data.trace).toHaveLength(1);
    expect(data.trace[0].verdict).toBe('UNSUPPORTED');
    expect(data.trace[0].conditionText).toBe('data.val() ===');
    expect(data.trace[0].message).toBeString();
  });

  test('the validate operation records only .validate rules', () => {
    const rules = { a: { '.write': 'false', '.validate': 'newData.isNumber()' } };
    const data = simulate(rules, { operation: 'validate', path: '/a', newData: 5 });
    expect(data.allowed).toBe(true);
    expect(data.trace.map((e) => [e.kind, e.verdict])).toEqual([['validate', 'ALLOW']]);
  });

  test('rtdbRules().simulate and explain carry the trace, and explainCase prints it', () => {
    const ruleset = rtdbRules({
      rules: { items: { $id: { '.write': 'auth != null', '.validate': 'newData.isNumber()' } } },
    });
    const oneCase = {
      expectation: 'ALLOW' as const,
      operation: 'write' as const,
      path: '/items/x',
      auth: 'alice',
      newData: 'text',
    };
    const result = ruleset.simulate([oneCase]).cases[0];
    expect(result.decision).toBe('DENY');
    expect(result.trace.map((e) => [e.kind, e.verdict])).toEqual([['write', 'ALLOW'], ['validate', 'DENY']]);
    expect(ruleset.explain(oneCase).trace).toEqual(result.trace);
    const text = explainCase(result);
    expect(text).toContain('rules evaluated:');
    expect(text).toContain('/items/$id .write -> ALLOW: auth != null');
    expect(text).toContain('/items/$id .validate -> DENY: newData.isNumber() ($id = x)');
  });
});
