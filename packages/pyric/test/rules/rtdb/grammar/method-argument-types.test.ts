/**
 * Method arguments, `$wildcard` variables and snapshot operands, checked as
 * production checks them. Production refuses to deploy a rule whose argument
 * types, argument count, variables or operand types are wrong where it can
 * see them (observation rtdb-rules-deploy-refusals), and fails a rule whose
 * argument turns out not to be a string when it runs (corpus scenario
 * r27-method-argument-types). An argument is never converted to a string.
 */
import { describe, expect, test } from 'bun:test';
import {
  DataSnapshot,
  RtdbRuleRuntimeError,
  evaluateRtdbExpression,
} from '../../../../src/rules/rtdb/grammar/simulator.js';
import { validateExpression } from '../../../../src/rules/rtdb/grammar/validator.js';
import { rtdbRules } from '../../../../src/rules/api/rtdb.js';

const ctx = (newData: unknown, data: unknown = null) => ({
  auth: null,
  data: new DataSnapshot(data),
  newData: new DataSnapshot(newData),
  root: new DataSnapshot({}),
  now: 0,
  pathVariableBindings: {},
});

function runtimeError(raw: string, newData: unknown, data: unknown = null): RtdbRuleRuntimeError {
  try {
    evaluateRtdbExpression(raw, ctx(newData, data));
  } catch (error) {
    expect(error).toBeInstanceOf(RtdbRuleRuntimeError);
    return error as RtdbRuleRuntimeError;
  }
  throw new Error(`${raw} evaluated without an error`);
}

const messages = (raw: string, context: 'read' | 'write' | 'validate' = 'validate', vars: string[] = []) =>
  validateExpression(raw, context, vars).map((e) => e.message);

describe('RTDB method arguments at evaluation', () => {
  test('hasChildren accepts no arguments or one array of strings', () => {
    expect(evaluateRtdbExpression("newData.hasChildren(['a'])", ctx({ a: 1 }))).toBe(true);
    expect(evaluateRtdbExpression("newData.hasChildren(['a', 'b'])", ctx({ a: 1 }))).toBe(false);
    expect(evaluateRtdbExpression('newData.hasChildren()', ctx({ a: 1 }))).toBe(true);
    expect(evaluateRtdbExpression('newData.hasChildren([])', ctx({ a: 1 }))).toBe(true);
    expect(evaluateRtdbExpression('newData.hasChildren([])', ctx(5))).toBe(true);
  });

  test("hasChildren('a', 'b') over { a: 1 } fails the rule", () => {
    expect(runtimeError("newData.hasChildren('a', 'b')", { a: 1 }).message)
      .toBe('hasChildren() expects only a single argument (containing an array of child names).');
    expect(runtimeError("newData.hasChildren('a')", { a: 1 }).message)
      .toBe('hasChildren() expects an array of child names.');
    expect(runtimeError("newData.hasChildren(['a', 1])", { a: 1 }).message)
      .toBe('hasChildren() expects an array of strings.');
  });

  test("'xnullx'.contains(data.val()) with absent data fails the rule", () => {
    expect(runtimeError("'xnullx'.contains(data.val())", 'x').message)
      .toBe('contains() expects a string argument.');
  });

  test('string methods fail on a number argument instead of converting it', () => {
    expect(runtimeError("newData.child('s').val().beginsWith(newData.child('p').val())", { s: '12ab', p: 12 }).message)
      .toBe('beginsWith() expects a string argument.');
    expect(runtimeError("newData.val().endsWith(data.val())", 'x1', 1).message)
      .toBe('endsWith() expects a string argument.');
    expect(evaluateRtdbExpression("newData.child('s').val().beginsWith(newData.child('p').val())", ctx({ s: '12ab', p: '12' }))).toBe(true);
  });

  test('child and hasChild fail on a null or number argument', () => {
    expect(runtimeError("newData.hasChild(newData.child('k').val())", { null: 1 }).message)
      .toBe('hasChild() expects a string argument.');
    expect(runtimeError("newData.hasChild(newData.child('k').val())", { k: 5, 5: 1 }).message)
      .toBe('hasChild() expects a string argument.');
    expect(runtimeError('data.child(auth.uid).exists()', null, { null: true }).message)
      .toBe('child() expects a string argument.');
  });

  test('replace fails on a replacement that is not a string', () => {
    expect(runtimeError("newData.child('s').val().replace('a', newData.child('r').val()) == 'x'", { s: 'a', r: 5 }).message)
      .toBe('Argument 2 of replace() must be a string.');
    expect(evaluateRtdbExpression("newData.child('s').val().replace('a', newData.child('r').val()) == 'x'", ctx({ s: 'a', r: 'x' }))).toBe(true);
  });

  test('replace reads a slash-delimited string pattern as a substring', () => {
    expect(evaluateRtdbExpression("newData.val().replace('/a/g', 'z') == 'z'", ctx('/a/g'))).toBe(true);
    expect(evaluateRtdbExpression("newData.val().replace('/a/g', 'z') == 'z'", ctx('a'))).toBe(false);
  });

  test('a snapshot operand of a comparison or arithmetic operator fails the rule', () => {
    expect(runtimeError("newData != 'locked'", 'open').message)
      .toBe('Invalid != expression: left operand is not a number, boolean, string, or null.');
    expect(runtimeError("'locked' == newData", 'open').message)
      .toBe('Invalid == expression: right operand is not a number, boolean, string, or null.');
    expect(runtimeError('newData + 1 > 0', 1).message)
      .toBe('Invalid + expression: left operand is not a number or string.');
    expect(runtimeError('newData < 5', 1).message)
      .toBe('Invalid < expression: left operand must be a number or string.');
    expect(runtimeError('newData * 2 > 0', 1).message)
      .toBe('Invalid * expression: left operand is not a number.');
  });
});

describe('RTDB method arguments, variables and operands before deploy', () => {
  test('hasChildren argument shape', () => {
    expect(messages("newData.hasChildren('a', 'b')"))
      .toEqual(['hasChildren() expects only a single argument (containing an array of child names).']);
    expect(messages("newData.hasChildren(['a'], ['b'])"))
      .toEqual(['hasChildren() expects only a single argument (containing an array of child names).']);
    expect(messages("newData.hasChildren('a')")).toEqual(['hasChildren() expects an array of child names.']);
    expect(messages('newData.hasChildren(data.val())')).toEqual(['hasChildren() expects an array of child names.']);
    expect(messages("newData.hasChildren(['a', 1])")).toEqual(['hasChildren() expects an array of strings.']);
    expect(messages('newData.hasChildren([])')).toEqual([]);
    expect(messages('newData.hasChildren()')).toEqual([]);
    expect(messages("newData.hasChildren(['a', 'b'])")).toEqual([]);
  });

  test('string argument literals and argument counts', () => {
    expect(messages('newData.val().beginsWith(12)')).toEqual(['beginsWith() expects a string argument.']);
    expect(messages('newData.val().contains(null)')).toEqual(['contains() expects a string argument.']);
    expect(messages('newData.val().endsWith(true)')).toEqual(['endsWith() expects a string argument.']);
    expect(messages('newData.val().beginsWith()')).toEqual(['beginsWith() expects 1 argument.']);
    expect(messages("newData.val().beginsWith('a', 'b')")).toEqual(['beginsWith() expects 1 argument.']);
    expect(messages('newData.child(5).exists()')).toEqual(['child() expects a string argument.']);
    expect(messages('newData.hasChild(null)')).toEqual(['hasChild() expects a string argument.']);
    expect(messages("newData.val().replace('a', 5) == 'x'")).toEqual(['Argument 2 of replace() must be a string.']);
    expect(messages("newData.val().replace(/a/, 'z') == 'zbc'")).toEqual(['Argument 1 of replace() must be a string.']);
    expect(messages('newData.val().contains(data.val())')).toEqual([]);
    expect(messages("root.child('users').child(auth.uid).exists()")).toEqual([]);
    expect(messages("newData.val().replace('/a/g', 'z') == 'z'")).toEqual([]);
  });

  test('a $variable must be declared on the path', () => {
    expect(messages('$undeclared == auth.uid', 'read')).toEqual(["Unknown variable '$undeclared'."]);
    expect(messages('$declared == auth.uid', 'read', ['$declared'])).toEqual([]);
    expect(messages('$outer == auth.uid', 'read', ['$outer'])).toEqual([]);
  });

  test('a $variable declared by a sibling is not in scope', () => {
    const compiled = rtdbRules({ rules: { $one: { '.read': true }, two: { '.read': '$one == auth.uid' } } });
    expect(compiled.lint().map((issue) => issue.message)).toContain("Unknown variable '$one'.");
  });

  test('snapshot operands of comparison and arithmetic operators', () => {
    expect(messages("data == 'locked'", 'write'))
      .toEqual(['Invalid == expression: left operand is not a number, boolean, string, null.']);
    expect(messages("'locked' == data", 'write'))
      .toEqual(['Invalid == expression: right operand is not a number, boolean, string, or null.']);
    expect(messages("data != 'locked'", 'write'))
      .toEqual(['Invalid != expression: left operand is not a number, boolean, string, or null.']);
    expect(messages("'locked' != data", 'write'))
      .toEqual(['Invalid != expression: right operand is not a number, boolean, string, or null.']);
    expect(messages("data === 'locked'", 'write'))
      .toEqual(['Invalid == expression: left operand is not a number, boolean, string, null.']);
    expect(messages("data !== 'locked'", 'write'))
      .toEqual(['Invalid != expression: left operand is not a number, boolean, string, or null.']);
    expect(messages("data.child('x') == 'locked'", 'write'))
      .toEqual(['Invalid == expression: left operand is not a number, boolean, string, null.']);
    expect(messages('data.parent() == data.parent()', 'write'))
      .toEqual(['Invalid == expression: left operand is not a number, boolean, string, null.']);
    expect(messages('newData + 1 > 0')).toEqual(['Invalid + expression: left operand is not a number or string.']);
    expect(messages('1 + newData > 0')).toEqual(['Invalid + expression: right operand is not a number or string.']);
    expect(messages('newData - 1 > 0')).toEqual(['Invalid - expression: left operand is not a number.']);
    expect(messages('newData * 2 > 0')).toEqual(['Invalid * expression: left operand is not a number.']);
    expect(messages('newData < 5')).toEqual(['Invalid < expression: left operand must be a number or string.']);
    expect(messages('5 < newData')).toEqual(['Invalid < expression: right operand must be a number or string.']);
    expect(messages('newData >= 5')).toEqual(['Invalid >= expression: left operand must be a number or string.']);
    expect(messages("data.val() == 'locked'", 'write')).toEqual([]);
    expect(messages('newData.val() + 1 > 0')).toEqual([]);
  });
});

describe('RTDB method argument errors in simulate', () => {
  test('a rule whose argument is not a string denies, and is not reported as unsupported', () => {
    const rules = {
      rules: {
        contains: { '.write': 'auth != null', '.validate': "newData.child('s').val().contains(newData.child('p').val())" },
        pair: { '.write': 'auth != null', '.validate': "newData.hasChildren('a', 'b')" },
      },
    };
    const { cases } = rtdbRules(rules).simulate([
      { expectation: 'DENY', operation: 'write', path: '/contains', auth: { uid: 'u' }, newData: { s: 'xnullx' } },
      { expectation: 'ALLOW', operation: 'write', path: '/contains', auth: { uid: 'u' }, newData: { s: 'xnullx', p: 'null' } },
      { expectation: 'DENY', operation: 'write', path: '/pair', auth: { uid: 'u' }, newData: { a: 1 } },
    ]);
    expect(cases.map((c) => [c.decision, c.unsupported])).toEqual([
      ['DENY', false],
      ['ALLOW', false],
      ['DENY', false],
    ]);
  });
});
