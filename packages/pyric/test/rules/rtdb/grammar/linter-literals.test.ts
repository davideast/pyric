import { describe, test, expect } from 'bun:test';
import { lintExpression } from '../../../../src/rules/rtdb/grammar/linter.js';
import { compileRtdbRules } from '../../../../src/rules/rtdb/compiled-rules.js';

const hardcoded = (raw: string, context: 'read' | 'write' | 'validate') =>
  lintExpression(raw, context)
    .map((w) => w.code)
    .filter((code) => code.startsWith('HARDCODED_'));

describe('lintExpression reports a hardcoded rule only when the whole expression is a boolean literal', () => {
  test('a .read or .write that is true or false outright is reported', () => {
    expect(hardcoded('true', 'read')).toEqual(['HARDCODED_TRUE']);
    expect(hardcoded('true', 'write')).toEqual(['HARDCODED_TRUE']);
    expect(hardcoded('false', 'read')).toEqual(['HARDCODED_FALSE']);
    expect(hardcoded('false', 'write')).toEqual(['HARDCODED_FALSE']);
  });

  test('a parenthesized literal is still the whole expression', () => {
    expect(hardcoded('(true)', 'read')).toEqual(['HARDCODED_TRUE']);
    expect(hardcoded(' ( ( false ) ) ', 'write')).toEqual(['HARDCODED_FALSE']);
  });

  test('a literal operand of a comparison is not reported', () => {
    expect(hardcoded("auth != null && data.child('open').val() == false", 'write')).toEqual([]);
    expect(hardcoded('newData.child("ready").val() == true', 'write')).toEqual([]);
    expect(hardcoded('data.child("closed").val() != true', 'read')).toEqual([]);
  });

  test('a literal nested in a logical, ternary, or call expression is not reported', () => {
    expect(hardcoded('auth != null && true', 'read')).toEqual([]);
    expect(hardcoded('auth.token.admin == true || false', 'write')).toEqual([]);
    expect(hardcoded('auth != null ? true : false', 'read')).toEqual([]);
    expect(hardcoded('!false', 'read')).toEqual([]);
    expect(hardcoded('newData.isBoolean() && newData.val() == false', 'write')).toEqual([]);
  });

  test('a .validate literal is not reported: true is a no-op and false rejects unknown children', () => {
    expect(hardcoded('true', 'validate')).toEqual([]);
    expect(hardcoded('false', 'validate')).toEqual([]);
  });
});

describe('compiled rules JSON: a boolean literal and the string of it lint the same', () => {
  test('JSON booleans and strings on .read, .write, and .validate', () => {
    const compiled = compileRtdbRules({
      rules: {
        booleans: { '.read': true, '.write': false, '$other': { '.validate': false } },
        strings: { '.read': 'true', '.write': 'false', '$other': { '.validate': 'false' } },
        compared: { '.write': "auth != null && data.child('open').val() == false", '.validate': true },
      },
    });
    const byPath = Object.fromEntries(compiled.children.map((node) => [node.path, node]));
    const codes = (path: string, rule: 'read' | 'write') =>
      byPath[path]![rule]!.parsed.warnings.map((w) => w.code);

    for (const path of ['/booleans', '/strings']) {
      expect(codes(path, 'read')).toEqual(['HARDCODED_TRUE']);
      expect(codes(path, 'write')).toEqual(['HARDCODED_FALSE']);
      expect(byPath[path]!.children[0]!.validate!.parsed.warnings).toEqual([]);
    }
    expect(codes('/compared', 'write')).toEqual([]);
    expect(byPath['/compared']!.validate!.parsed.warnings).toEqual([]);
  });
});
