/**
 * Regular expression literals as production's compiler reads them
 * (observation rtdb-rules-deploy-refusals), and lint findings for a
 * comparison whose operands are both literals.
 */
import { describe, expect, test } from 'bun:test';
import { parseExpression } from '../../../../src/rules/rtdb/grammar/RtdbExprParser.js';
import { lintExpression } from '../../../../src/rules/rtdb/grammar/linter.js';
import {
  DataSnapshot,
  RtdbRuleRuntimeError,
  evaluateRtdbExpression,
} from '../../../../src/rules/rtdb/grammar/simulator.js';
import { validateExpression } from '../../../../src/rules/rtdb/grammar/validator.js';
import { rtdbRules } from '../../../../src/rules/api/rtdb.js';

const ctx = (newData: unknown) => ({
  auth: null,
  data: new DataSnapshot(null),
  newData: new DataSnapshot(newData),
  root: new DataSnapshot({}),
  now: 0,
  pathVariableBindings: {},
});

const messages = (raw: string) => validateExpression(raw, 'validate').map((e) => e.message);

describe('RTDB regular expression literals', () => {
  test('matches takes only a regular expression literal', () => {
    expect(messages("newData.val().matches('^a')")).toEqual(['matches() expects a regular expression literal argument.']);
    expect(messages("newData.val().matches('/^a/i')")).toEqual(['matches() expects a regular expression literal argument.']);
    expect(messages('newData.val().matches(/^a/)')).toEqual([]);
  });

  test('a string given to matches fails the rule when it runs', () => {
    expect(() => evaluateRtdbExpression("newData.val().matches('^a')", ctx('abc'))).toThrow(RtdbRuleRuntimeError);
    expect(() => evaluateRtdbExpression("newData.val().matches('^a')", ctx('abc')))
      .toThrow('matches() expects a regular expression literal argument.');
  });

  test('the only flag is i', () => {
    expect(messages('newData.val().matches(/^A/i)')).toEqual([]);
    expect(messages('newData.val().matches(/^A/g)')).toEqual(['regular expressions do not support flags other than i']);
    expect(messages('newData.val().matches(/^A/im)')).toEqual(['regular expressions do not support flags other than i']);
    expect(evaluateRtdbExpression('newData.val().matches(/^A/i)', ctx('abc'))).toBe(true);
  });

  test('a slash inside a character class does not end the literal', () => {
    expect(parseExpression('newData.val().matches(/[a/)').valid).toBe(false);
    expect(parseExpression('newData.val().matches(/[/]/)').valid).toBe(true);
    expect(evaluateRtdbExpression('newData.val().matches(/^[/]$/)', ctx('/'))).toBe(true);
    expect(evaluateRtdbExpression('newData.val().matches(/^a\\/b$/)', ctx('a/b'))).toBe(true);
  });

  test('replace reads a slash-delimited string as text', () => {
    expect(evaluateRtdbExpression("newData.val().replace('/a/g', 'z') == 'z'", ctx('/a/g'))).toBe(true);
    expect(evaluateRtdbExpression("newData.val().replace('/a/g', 'z') == 'z'", ctx('a'))).toBe(false);
  });
});

describe('RTDB lint of comparisons between literals', () => {
  test('a .read or .write that is a constant comparison is hardcoded', () => {
    expect(lintExpression('1 == 1', 'read')).toEqual([{ code: 'HARDCODED_TRUE', message: 'Rule expression is hardcoded to true' }]);
    expect(lintExpression('(1 != 1)', 'write')).toEqual([{ code: 'HARDCODED_FALSE', message: 'Rule expression is hardcoded to false' }]);
    expect(lintExpression("1 == '1'", 'read')).toEqual([{ code: 'HARDCODED_FALSE', message: 'Rule expression is hardcoded to false' }]);
  });

  test('a constant comparison inside a larger rule is reported as one', () => {
    expect(lintExpression("auth != null && 'a' == 'a'", 'read'))
      .toEqual([{ code: 'CONSTANT_COMPARISON', message: "Comparison 'a' == 'a' is always true." }]);
    expect(lintExpression('newData.isNumber() || 0 != 0', 'validate'))
      .toEqual([{ code: 'CONSTANT_COMPARISON', message: 'Comparison 0 != 0 is always false.' }]);
    expect(lintExpression('1 == 1', 'validate'))
      .toEqual([{ code: 'CONSTANT_COMPARISON', message: 'Comparison 1 == 1 is always true.' }]);
  });

  test('a literal comparison that fails when it runs is not folded, and compiling it does not throw', () => {
    expect(lintExpression('auth != null && null > 1', 'read')).toEqual([]);
    expect(lintExpression('newData.val().matches(/a/g) || /a/g == /a/g', 'validate')).toEqual([]);
    const rules = rtdbRules({
      rules: {
        a: { '.read': 'auth != null && null > 1' },
        b: { '.write': true, '.validate': 'newData.val().matches(/a/g) || /a/g == /a/g' },
      },
    });
    expect(rules.lint().map((issue) => issue.code)).not.toContain('COMPILE_ERROR');
    const [read] = rules.simulate([{ expectation: 'DENY', operation: 'read', path: '/a', auth: { uid: 'u' } }]).cases;
    expect(read!.decision).toBe('DENY');
  });

  test('a comparison that reads data is not constant', () => {
    expect(lintExpression("data.val() == 'profile'", 'read')).toEqual([]);
    expect(lintExpression('auth.uid == $uid', 'read')).toEqual([]);
  });
});
