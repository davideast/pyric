/**
 * ─── Scenario: conversion-functions ──────────────────────────────────────────
 * The global conversion functions `int()`, `string()`, and `float()` in Storage
 * rules. Each case is one `allow create` condition on its own path, evaluated
 * against an upload whose custom metadata values are strings.
 *
 * `int(string)` parses the whole string as a signed 64-bit decimal integer:
 * a sign is allowed, and whitespace, a fraction, hex, and out-of-range values
 * are a "Type conversion error". `int(float)` truncates toward zero, saturates
 * at the int64 bounds, and maps NaN to 0. `float(string)` accepts decimal and
 * exponent forms, surrounding whitespace, `NaN`, `Infinity`, hex float, and an
 * `f` or `d` suffix, and rejects `inf`, `nan`, and other text. `string()`
 * accepts int, float, null, string, bool, and path. A float stringifies with
 * at least one fractional digit, in scientific notation outside [1e-3, 1e7),
 * as Java's `Double.toString` prints it: when the shortest form has one
 * significant digit, the closest two-digit form wins, so the smallest
 * subnormal prints as `4.9E-324`, not `5.0E-324`.
 * Any other argument type is an "Unsupported operation error".
 *
 * Every conversion failure is an error value: it denies through `!=` and `!`,
 * and `|| true` absorbs it. The same holds for a call to an undefined function
 * ("Function not found error") and for a call with the wrong number of
 * arguments ("Incorrect number of arguments"). A ruleset function named `int`
 * shadows the global one.
 */
import type { StorageScenarioRecord, StorageTestCase } from './types.ts';

interface ConversionCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
  note?: string;
}

const conversions: ConversionCase[] = [
  { key: 'intFromString', condition: "int('12') == 12 && int('12') is int", expectation: 'ALLOW' },
  { key: 'intFromMetadata', condition: 'int(request.resource.metadata.moves) == 12', expectation: 'ALLOW' },
  { key: 'intSignsAndZeros', condition: "int('-3') == -3 && int('+3') == 3 && int('007') == 7 && int('-0') == 0", expectation: 'ALLOW' },
  { key: 'intInt64Min', condition: "int('-9223372036854775808') == -9223372036854775808", expectation: 'ALLOW' },
  { key: 'intFromFloatTruncates', condition: 'int(2.0) == 2 && int(2.9) == 2 && int(-2.9) == -2 && int(2.5) is int', expectation: 'ALLOW' },
  { key: 'intFromFloatNotRounded', condition: 'int(2.9) == 3', expectation: 'DENY' },
  { key: 'intFromComputedFloat', condition: 'int(request.resource.size + 0.9) == 2', expectation: 'ALLOW' },
  { key: 'intFromFloatSaturates', condition: "int(float('1e20')) == 9223372036854775807 && int(float('-1e20')) == -9223372036854775808 && int(float('NaN')) == 0", expectation: 'ALLOW' },
  { key: 'intInt64Max', condition: "int(9223372036854775807) == 9223372036854775807 && int(float('9.3e18')) == 9223372036854775807 && int(float('-9.3e18')) == -9223372036854775808", expectation: 'ALLOW' },
  { key: 'intExponentString', condition: "int('1e3') != 0", expectation: 'DENY' },
  { key: 'intOverflow', condition: "int('9223372036854775808') != 0", expectation: 'DENY', note: 'out of int64 range' },
  { key: 'intTrailingText', condition: 'int(request.resource.metadata.bad) != 12', expectation: 'DENY', note: "'12abc'" },
  { key: 'intText', condition: "int('x') != 0", expectation: 'DENY' },
  { key: 'intTextNot', condition: "!(int('x') == 0)", expectation: 'DENY' },
  { key: 'intTextOrTrue', condition: '(int(request.resource.metadata.x) == 0) || true', expectation: 'ALLOW' },
  { key: 'intDecimalString', condition: "int('1.5') != 0", expectation: 'DENY' },
  { key: 'intLeadingSpace', condition: 'int(request.resource.metadata.sp) == 12', expectation: 'DENY', note: "' 12'" },
  { key: 'intTrailingSpace', condition: "int('12 ') == 12", expectation: 'DENY' },
  { key: 'intHexString', condition: "int('0x10') != 0", expectation: 'DENY' },
  { key: 'intEmptyString', condition: "int('') != 0", expectation: 'DENY' },
  { key: 'intBool', condition: 'int(true) != 0', expectation: 'DENY' },
  { key: 'intBoolOrTrue', condition: '(int(true) == 1) || true', expectation: 'ALLOW' },
  { key: 'intNull', condition: 'int(null) != 0', expectation: 'DENY' },
  { key: 'intTwoArgs', condition: "int('1', 2) == 1", expectation: 'DENY' },
  { key: 'intTwoArgsOrTrue', condition: "int('1', 2) == 1 || true", expectation: 'ALLOW' },
  { key: 'stringFromInt', condition: "string(12) == '12' && string(-5) == '-5' && string(12) is string && string(request.resource.size) == '2'", expectation: 'ALLOW' },
  { key: 'stringFromFloat', condition: "string(1.5) == '1.5' && string(2.0) == '2.0' && string(0.1 + 0.2) == '0.30000000000000004' && string(-0.0) == '-0.0'", expectation: 'ALLOW' },
  { key: 'stringFromFloatNoIntForm', condition: "string(2.0) == '2'", expectation: 'DENY' },
  { key: 'stringFromFloatScientific', condition: "string(float('1e7')) == '1.0E7' && string(float('1e6')) == '1000000.0' && string(float('9999999.0')) == '9999999.0' && string(float('1e-3')) == '0.001' && string(float('1e-4')) == '1.0E-4' && string(123456789.0) == '1.23456789E8' && string(float('-1.5e10')) == '-1.5E10' && string(float('1e20')) == '1.0E20' && string(float('1.7976931348623157e308')) == '1.7976931348623157E308'", expectation: 'ALLOW' },
  { key: 'stringFromFloatDigits', condition: "string(1.0) == '1.0' && string(1.0 / 3.0) == '0.3333333333333333' && string(float('1e21')) == '1.0E21' && string(float('1.0e23')) == '1.0E23' && string(float('2.82879384806159e17')) == '2.82879384806159E17' && string(float('2.2250738585072014e-308')) == '2.2250738585072014E-308'", expectation: 'ALLOW' },
  { key: 'stringFromFloatSubnormal', condition: "string(float('4.9e-324')) == '4.9E-324' && string(float('-4.9e-324')) == '-4.9E-324' && string(float('1e-323')) == '9.9E-324' && string(float('2e-323')) == '2.0E-323' && string(float('1e-322')) == '9.9E-323' && string(float('1e-310')) == '1.0E-310'", expectation: 'ALLOW' },
  { key: 'stringFromFloatSubnormalNot', condition: "string(float('4.9e-324')) != '4.9E-324'", expectation: 'DENY' },
  { key: 'stringFromFloatSubnormalShortest', condition: "string(float('4.9e-324')) == '5.0E-324'", expectation: 'DENY' },
  { key: 'stringFromFloatSpecial', condition: "string(float('NaN')) == 'NaN' && string(float('-Infinity')) == '-Infinity'", expectation: 'ALLOW' },
  { key: 'stringFromBoolNullString', condition: "string(true) == 'true' && string(null) == 'null' && string('s') == 's' && string(request.resource.metadata.t) == 'true'", expectation: 'ALLOW' },
  { key: 'stringFromPath', condition: "string(path('a/b')) == '/a/b' && string(path('/a/b')) == '/a/b'", expectation: 'ALLOW' },
  { key: 'stringFromList', condition: "string([1, 2]) != ''", expectation: 'DENY' },
  { key: 'stringFromListOrTrue', condition: "(string([1, 2]) == '') || true", expectation: 'ALLOW' },
  { key: 'stringFromMap', condition: "string({'a': 1}) != ''", expectation: 'DENY' },
  { key: 'stringFromBytes', condition: "string('abc'.toUtf8()) != ''", expectation: 'DENY' },
  { key: 'stringFromDuration', condition: "string(duration.value(1, 's')) != ''", expectation: 'DENY' },
  { key: 'stringFromLatLng', condition: "string(latlng.value(1, 2)) != ''", expectation: 'DENY' },
  { key: 'floatFromString', condition: "float('2.0') == 2.0 && float(request.resource.metadata.fl) == 1.5 && float('1.5') is float", expectation: 'ALLOW' },
  { key: 'floatFromInt', condition: 'float(2) == 2.0 && float(2) is float && float(float(2)) == 2.0', expectation: 'ALLOW' },
  { key: 'floatStringForms', condition: "float('1e3') == 1000.0 && float('.5') == 0.5 && float('5.') == 5.0 && float('1.5f') == 1.5 && float('1.5d') == 1.5 && float('0x1p3') == 8.0 && float(' 2.5') == 2.5 && float('2.5 ') == 2.5", expectation: 'ALLOW' },
  { key: 'floatStringSpecial', condition: "float('NaN') != float('NaN') && float('Infinity') > 1.0 && float('+Infinity') > 1.0 && float('-Infinity') < 1.0", expectation: 'ALLOW' },
  { key: 'floatText', condition: "float('abc') != 0.0", expectation: 'DENY' },
  { key: 'floatTextOrTrue', condition: '(float(request.resource.metadata.x) == 0.0) || true', expectation: 'ALLOW' },
  { key: 'floatInf', condition: "float('inf') > 1.0", expectation: 'DENY' },
  { key: 'floatLowercaseNan', condition: "float('nan') != 0.0", expectation: 'DENY' },
  { key: 'floatTwoDots', condition: "float('1.2.3') != 0.0", expectation: 'DENY' },
  { key: 'floatUnderscore', condition: "float('1_000') != 0.0", expectation: 'DENY' },
  { key: 'floatEmptyString', condition: "float('') != 0.0", expectation: 'DENY' },
  { key: 'floatBool', condition: 'float(true) != 0.0', expectation: 'DENY' },
  { key: 'floatNull', condition: 'float(null) != 0.0', expectation: 'DENY' },
  { key: 'undefinedFunction', condition: 'foo(1) != 1', expectation: 'DENY' },
  { key: 'undefinedFunctionOrTrue', condition: 'foo(1) == 1 || true', expectation: 'ALLOW' },
  { key: 'undefinedFunctionAndFalse', condition: '!(foo(1) && false)', expectation: 'ALLOW' },
  { key: 'userFunctionTwoArgs', condition: 'isOne(1, 2)', expectation: 'DENY' },
  { key: 'userFunctionTwoArgsOrTrue', condition: 'isOne(1, 2) || true', expectation: 'ALLOW' },
];

const upload = {
  size: 2,
  contentType: 'text/plain',
  metadata: { moves: '12', fl: '1.5', bad: '12abc', x: 'x', sp: ' 12', t: 'true' },
};

function uploadCase(path: string, description: string, expectation: 'ALLOW' | 'DENY'): StorageTestCase {
  return { description, expectation, method: 'create', path, auth: { uid: 'alice' }, resource: upload };
}

const matchBlocks = conversions
  .map(({ key, condition }) => `    match /${key}/{file} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: int(), string(), float() conversions',
  rationale:
    'int() parses a whole int64 decimal string and truncates or saturates a float, float() parses a string with Java double syntax, string() formats int, float, null, bool, string, and path, and every conversion failure, undefined function, and wrong argument count is an error value that || true absorbs; a ruleset function named int shadows the global one.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isOne(n) { return n == 1; }
${matchBlocks}
    match /shadowed/{file} {
      function int(x) { return 5; }
      allow create: if int('1') == 5;
    }
    match /shadowedNot/{file} {
      function int(x) { return 5; }
      allow create: if int('1') == 1;
    }
  }
}`,
  cases: [
    ...conversions.map(({ key, condition, expectation, note }) =>
      uploadCase(`${key}/a.txt`, `${condition}${note ? ` (${note})` : ''} → ${expectation}`, expectation)),
    uploadCase('shadowed/a.txt', "a ruleset function int(x) returning 5 shadows the global: int('1') == 5 → ALLOW", 'ALLOW'),
    uploadCase('shadowedNot/a.txt', "a ruleset function int(x) returning 5 shadows the global: int('1') == 1 → DENY", 'DENY'),
  ],
};
