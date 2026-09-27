import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── Global conversion functions: int(), string(), float() ───────
//
// rules-storage-conversion-functions captures the production verdicts these
// tests pin. Custom metadata values are strings, so a rule that compares one
// with a number converts it first.

const path = 'b/pyric-default/o/users/alice/a.txt';

function evalCreate(cond: string, functions = ''): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`rules_version = '2';
  service firebase.storage {
    match /b/{bucket}/o {
      ${functions}
      match /users/{uid}/{file} { allow create: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(rules, {
    request: {
      auth: { uid: 'alice' },
      method: 'create',
      path,
      resource: {
        size: 2,
        contentType: 'text/plain',
        metadata: { moves: '12', bad: '12abc', sp: ' 12' },
      },
    },
    resource: null,
  });
}

function allows(cond: string): boolean {
  return evalCreate(cond).allowed;
}

describe('evaluateStorageRules: int(), string(), and float()', () => {
  it('converts values the way an upload rule compares metadata with numbers', () => {
    expect(allows("int('12') == 12")).toBe(true);
    expect(allows('int(request.resource.metadata.moves) == 12')).toBe(true);
    expect(allows('int(2.0) == 2')).toBe(true);
    expect(allows("string(12) == '12'")).toBe(true);
    expect(allows("float('2.0') == 2.0")).toBe(true);
    expect(allows('float(2) == 2.0')).toBe(true);
  });

  it('int() parses a whole signed int64 decimal string', () => {
    expect(allows("int('-3') == -3 && int('+3') == 3 && int('007') == 7 && int('-0') == 0")).toBe(true);
    expect(allows("int('12') is int")).toBe(true);
    expect(allows("int('-9223372036854775808') == -9223372036854775808")).toBe(true);
    for (const text of ['12abc', 'x', '1.5', '12 ', '0x10', '', '9223372036854775808']) {
      const r = evalCreate(`int('${text}') != 0`);
      expect(r.allowed).toBe(false);
      expect(r.reasons.join(' ')).toContain(
        `Type conversion error. Argument: [${text}], From type: [string], To type: [int].`,
      );
    }
    expect(allows('int(request.resource.metadata.sp) == 12')).toBe(false);
  });

  it('int() truncates a float toward zero, saturates at the int64 bounds, and maps NaN to 0', () => {
    expect(allows('int(2.9) == 2 && int(-2.9) == -2 && int(2.5) is int')).toBe(true);
    expect(allows('int(2.9) == 3')).toBe(false);
    expect(allows('int(request.resource.size + 0.9) == 2')).toBe(true);
    expect(allows("int(float('1e20')) == 9223372036854775807")).toBe(true);
    expect(allows("int(float('-1e20')) == -9223372036854775808")).toBe(true);
    expect(allows("int(float('NaN')) == 0")).toBe(true);
  });

  it('string() formats int, float, bool, null, string, and path', () => {
    expect(allows("string(-5) == '-5' && string(12) is string && string(request.resource.size) == '2'")).toBe(true);
    expect(allows("string(1.5) == '1.5' && string(2.0) == '2.0' && string(-0.0) == '-0.0'")).toBe(true);
    expect(allows("string(0.1 + 0.2) == '0.30000000000000004'")).toBe(true);
    expect(allows("string(2.0) == '2'")).toBe(false);
    expect(allows("string(true) == 'true' && string(null) == 'null' && string('s') == 's'")).toBe(true);
    expect(allows("string(path('a/b')) == '/a/b' && string(path('/a/b')) == '/a/b'")).toBe(true);
  });

  it('string() of a float uses scientific notation outside [1e-3, 1e7)', () => {
    expect(allows("string(float('1e7')) == '1.0E7'")).toBe(true);
    expect(allows("string(float('9999999.0')) == '9999999.0'")).toBe(true);
    expect(allows("string(float('1e6')) == '1000000.0'")).toBe(true);
    expect(allows("string(float('1e-3')) == '0.001'")).toBe(true);
    expect(allows("string(float('1e-4')) == '1.0E-4'")).toBe(true);
    expect(allows("string(123456789.0) == '1.23456789E8'")).toBe(true);
    expect(allows("string(float('-1.5e10')) == '-1.5E10'")).toBe(true);
    expect(allows("string(float('1e20')) == '1.0E20'")).toBe(true);
    expect(allows("string(float('1.7976931348623157e308')) == '1.7976931348623157E308'")).toBe(true);
    expect(allows("string(float('NaN')) == 'NaN' && string(float('-Infinity')) == '-Infinity'")).toBe(true);
  });

  it('float() parses the forms production accepts', () => {
    expect(allows("float('1.5') is float && float(2) is float && float(float(2)) == 2.0")).toBe(true);
    expect(allows("float('1e3') == 1000.0 && float('.5') == 0.5 && float('5.') == 5.0")).toBe(true);
    expect(allows("float('1.5f') == 1.5 && float('1.5d') == 1.5 && float('0x1p3') == 8.0")).toBe(true);
    expect(allows("float(' 2.5') == 2.5 && float('2.5 ') == 2.5")).toBe(true);
    expect(allows("float('NaN') != float('NaN') && float('Infinity') > 1.0 && float('+Infinity') > 1.0")).toBe(true);
    expect(allows("float('-Infinity') < 1.0")).toBe(true);
    for (const text of ['abc', 'inf', 'nan', '1.2.3', '1_000', '']) {
      const r = evalCreate(`float('${text}') != 0.0`);
      expect(r.allowed).toBe(false);
      expect(r.reasons.join(' ')).toContain(
        `Type conversion error. Argument: [${text}], From type: [string], To type: [float].`,
      );
    }
  });

  it('rejects argument types production has no overload for', () => {
    const cases: Array<[string, string]> = [
      ['int(true) != 0', 'Received: int(bool). Expected: int(int), int(float), int(string).'],
      ['int(null) != 0', 'Received: int(null).'],
      ['float(true) != 0.0', 'Received: float(bool). Expected: float(int), float(float), float(string).'],
      ['float(null) != 0.0', 'Received: float(null).'],
      [
        "string([1, 2]) != ''",
        'Received: string(list). Expected: string(int), string(float), string(null), string(string), string(bool), string(path).',
      ],
      ["string({'a': 1}) != ''", 'Received: string(map).'],
      ["string('abc'.toUtf8()) != ''", 'Received: string(bytes).'],
    ];
    for (const [cond, message] of cases) {
      const r = evalCreate(cond);
      expect(r.allowed).toBe(false);
      expect(r.reasons.join(' ')).toContain(`Unsupported operation error. ${message}`);
    }
  });

  it('a conversion error is an error value that || true absorbs', () => {
    expect(allows("int('12') == 12 || true")).toBe(true);
    expect(allows("(int('x') == 0) || true")).toBe(true);
    expect(allows("!(int('x') == 0)")).toBe(false);
    expect(allows('(int(true) == 1) || true')).toBe(true);
    expect(allows("(float('abc') == 0.0) || true")).toBe(true);
    expect(allows("(string([1, 2]) == '') || true")).toBe(true);
  });

  it('a wrong argument count is an error value that || true absorbs', () => {
    const r = evalCreate("int('1', 2) == 1");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain(
      'Incorrect number of arguments. Received: 2. Expected: int(int), int(float), int(string).',
    );
    expect(allows("int('1', 2) == 1 || true")).toBe(true);
  });

  it('a ruleset function with the same name shadows the global', () => {
    const fn = 'function int(x) { return 5; }';
    expect(evalCreate("int('1') == 5", fn).allowed).toBe(true);
    expect(evalCreate("int('1') == 1", fn).allowed).toBe(false);
  });
});

describe('evaluateStorageRules: undefined functions and argument counts', () => {
  it('an undefined function is an error value that || true absorbs', () => {
    const r = evalCreate('foo(1) != 1');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [foo].');
    expect(allows('foo(1) == 1 || true')).toBe(true);
    expect(allows('!(foo(1) && false)')).toBe(true);
  });

  it('bool() is not a global function: every call is a Function not found error value', () => {
    for (const arg of ["'true'", "'false'", "'TRUE'", "'1'", '1', '0', 'true', 'null', '[]']) {
      const r = evalCreate(`bool(${arg}) == true`);
      expect(r.allowed).toBe(false);
      expect(r.reasons.join(' ')).toContain('Function not found error: Name: [bool].');
      expect(allows(`!(bool(${arg}) == true)`)).toBe(false);
    }
    expect(allows("bool('true')")).toBe(false);
    expect(allows("bool('true') == true || true")).toBe(true);
    expect(allows("!(bool('true') && false)")).toBe(true);
    expect(evalCreate("bool('yes')", "function bool(x) { return x == 'yes'; }").allowed).toBe(true);
  });

  it('a ruleset function called with the wrong argument count is an error value that || true absorbs', () => {
    const fn = 'function isOne(n) { return n == 1; }';
    const r = evalCreate('isOne(1, 2)', fn);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Incorrect number of arguments. Received: 2. Expected: isOne(n).');
    expect(evalCreate('isOne(1, 2) || true', fn).allowed).toBe(true);
  });
});
