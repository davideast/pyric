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

  test('an unclosed group in a regex literal is rejected with production position text, while bare quantifiers and reversed ranges are accepted (FUZ-2)', () => {
    expect(validateExpression('auth.uid.matches(/(/)', 'read')).toEqual([
      { code: 'INVALID_REGEX', message: "Illegal regular expression, expected ')' at position 5" },
    ]);
    expect(validateExpression('auth.uid.matches(/+/)', 'read')).toEqual([]);
    expect(validateExpression('auth.uid.matches(/[z-a]/)', 'read')).toEqual([]);
    expect(validateExpression('auth.uid.matches(/a{2,1}/)', 'read')).toEqual([]);
    expect(validateExpression('auth.uid.matches(/^[^/]+$/)', 'read')).toEqual([]);
  });

  test('double-quoted string escapes and raw newlines match production deploy verdicts (FUZ-1)', () => {
    expect(validateExpression('auth.uid == "\\\'"', 'read')).toEqual([]);
    expect(validateExpression('auth.uid == "\\x41"', 'read')).toEqual([]);
    expect(validateExpression('auth.uid == "a\tb"', 'read')).toEqual([]);
    expect(validateExpression('data.child("\\\'").exists()', 'read')).toEqual([]);
    expect(validateExpression('data.child("\\x41").exists()', 'read')).toEqual([]);
    expect(validateExpression('data.child("a\tb").exists()', 'read')).toEqual([]);
    expect(parseExpression('auth.uid == "a\nb"').errors).toEqual([
      { code: 'PARSE_ERROR', message: 'unterminated string literal' },
    ]);
    expect(validateExpression('auth.uid == "a\nb"', 'read')).toEqual([
      { code: 'PARSE_ERROR', message: 'unterminated string literal' },
    ]);
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
    // Production refuses to deploy `null > 1` (`rtdb-rules-type-check`,
    // `rtdb-rules-deploy-refusals` `INVALID_OPERAND`), so `simulate` reports
    // `UNSUPPORTED` rather than evaluating it (TXT-1).
    expect(read!.decision).toBe('UNSUPPORTED');
    expect(read!.unsupported).toBe(true);
  });

  test('a comparison that reads data is not constant', () => {
    expect(lintExpression("data.val() == 'profile'", 'read')).toEqual([]);
    expect(lintExpression('auth.uid == $uid', 'read')).toEqual([]);
  });
});
