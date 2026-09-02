import { describe, test, expect } from 'bun:test';
import { parseExpression } from '../../../src/rules/grammar/FirestoreParser.js';

function valid(input: string) {
  const result = parseExpression(input);
  expect(result.valid).toBe(true);
}

function invalid(input: string) {
  const result = parseExpression(input);
  expect(result.valid).toBe(false);
}

describe('Firestore Expression Parser', () => {
  // --- Literals ---
  describe('literals', () => {
    test('true', () => valid('true'));
    test('false', () => valid('false'));
    test('null', () => valid('null'));
    test('integer', () => valid('42'));
    test('negative integer', () => valid('-1'));
    test('zero', () => valid('0'));
    test('float', () => valid('3.14'));
    test('negative float', () => valid('-0.5'));
    test('single-quoted string', () => valid("'hello'"));
    test('double-quoted string', () => valid('"world"'));
    test('escaped single quote', () => valid("'it\\'s'"));
    test('escaped backslash', () => valid("'path\\\\here'"));
    test('escaped newline', () => valid("'line1\\nline2'"));
    test('empty string', () => valid("''"));
    test('empty list', () => valid('[]'));
    test('int list', () => valid('[1, 2, 3]'));
    test('string list', () => valid("['a', 'b', 'c']"));
    test('nested list', () => valid('[[1], [2]]'));
    test('empty map', () => valid('{}'));
    test('map with unquoted keys', () => valid('{key: value}'));
    test('map with quoted keys', () => valid("{'key': 'value'}"));
    test('map with multiple entries', () => valid("{a: 1, b: 2, c: 3}"));
  });

  // --- Comparison operators ---
  describe('comparison operators', () => {
    test('==', () => valid('a == b'));
    test('!=', () => valid('a != b'));
    test('>', () => valid('a > b'));
    test('>=', () => valid('a >= b'));
    test('<', () => valid('a < b'));
    test('<=', () => valid('a <= b'));
  });

  // --- Boolean operators ---
  describe('boolean operators', () => {
    test('&&', () => valid('a && b'));
    test('||', () => valid('a || b'));
    test('! (negation)', () => valid('!a'));
    test('double negation', () => valid('!!a'));
    test('complex boolean', () => valid('a && b || c'));
    test('negation with comparison', () => valid('!(a == b)'));
  });

  // --- Arithmetic operators ---
  describe('arithmetic operators', () => {
    test('+', () => valid('a + b'));
    test('-', () => valid('a - b'));
    test('*', () => valid('a * b'));
    test('/', () => valid('a / b'));
    test('%', () => valid('a % b'));
    test('unary negate', () => valid('-a'));
    test('complex arithmetic', () => valid('a + b * c - d / e'));
  });

  // --- Ternary ---
  describe('ternary', () => {
    test('simple', () => valid('a ? b : c'));
    test('with comparisons', () => valid('x > 0 ? x : -x'));
    test('nested', () => valid('a ? b ? c : d : e'));
  });

  // --- Member access ---
  describe('member access', () => {
    test('single property', () => valid('request.auth'));
    test('chained properties', () => valid('request.auth.uid'));
    test('deep chain', () => valid('request.auth.token.email'));
    test('resource.data', () => valid('resource.data'));
    test('request.resource.data', () => valid('request.resource.data'));
    test('request.time', () => valid('request.time'));
    test('request.method', () => valid('request.method'));
  });

  // --- Method calls ---
  describe('method calls', () => {
    test('no args', () => valid('data.size()'));
    test('one arg', () => valid("name.matches('^[a-z]+$')"));
    test('two args', () => valid("data.get('key', null)"));
    test('chained', () => valid("data.keys().hasAll(['a', 'b'])"));
    test('deep chain', () => valid("request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name'])"));
  });

  // --- Bracket access ---
  describe('bracket access', () => {
    test('string key', () => valid("data['field']"));
    test('variable key', () => valid('data[variable]'));
    test('chained with method', () => valid("data['field'].size()"));
  });

  // --- in operator ---
  describe('in operator', () => {
    test('string in map', () => valid("'key' in data"));
    test('string in list', () => valid("'value' in ['a', 'b', 'c']"));
    test('field in resource', () => valid("'title' in request.resource.data"));
    test('value in enum list', () => valid("request.resource.data.role in ['admin', 'user']"));
  });

  // --- is operator ---
  describe('is operator', () => {
    test('is string', () => valid('value is string'));
    test('is int', () => valid('value is int'));
    test('is float', () => valid('value is float'));
    test('is number', () => valid('value is number'));
    test('is bool', () => valid('value is bool'));
    test('is list', () => valid('value is list'));
    test('is map', () => valid('value is map'));
    test('is timestamp', () => valid('value is timestamp'));
    test('is path', () => valid('value is path'));
    test('is bytes', () => valid('value is bytes'));
    test('chained with member', () => valid('request.resource.data.name is string'));
  });

  // --- Path literals ---
  describe('path literals', () => {
    test('simple path', () => valid('/databases/$(database)/documents/users/$(uid)'));
    test('with expression interpolation', () => valid('/databases/$(database)/documents/users/$(request.auth.uid)'));
  });

  // --- Namespaced functions ---
  describe('namespaced functions', () => {
    test('math.abs', () => valid('math.abs(-5)'));
    test('math.ceil', () => valid('math.ceil(3.2)'));
    test('math.floor', () => valid('math.floor(3.8)'));
    test('math.round', () => valid('math.round(3.5)'));
    // NOTE: math.isInfinite is deliberately absent, because production Firestore
    // rejects it at compile ("Function not found error: Name: [math.isInfinite]").
    // It still PARSES (grammar has no function table), but it must never be
    // exercised as a valid namespaced function; the linter/evaluator reject it.
    test('math.isNaN', () => valid('!math.isNaN(1)'));
    test('hashing.sha256', () => valid("hashing.sha256('test'.toUtf8())"));
    test('hashing.md5', () => valid("hashing.md5('test'.toUtf8())"));
    test('latlng.value', () => valid('latlng.value(37.0, -122.0)'));
    test('duration.value', () => valid("duration.value(60, 's')"));
    test('debug', () => valid('debug(request.auth != null)'));
  });

  // --- Global functions ---
  describe('global functions', () => {
    test('get()', () => valid('get(/databases/$(database)/documents/users/$(uid))'));
    test('exists()', () => valid('exists(/databases/$(database)/documents/users/$(uid))'));
    test('getAfter()', () => valid('getAfter(/databases/$(database)/documents/test/$(docId))'));
    test('get().data access', () => valid('get(/databases/$(database)/documents/users/$(uid)).data.role'));
  });

  // --- Complex compositions ---
  describe('complex compositions', () => {
    test('auth check', () => valid('request.auth != null'));
    test('auth + uid', () => valid('request.auth != null && request.auth.uid == userId'));
    test('data validation', () => valid("request.resource.data.title is string && request.resource.data.title.size() > 0"));
    test('keys validation', () => valid("request.resource.data.keys().hasAll(['title', 'body'])"));
    test('timestamp comparison', () => valid("request.time > resource.data.updatedAt + duration.value(60, 's')"));
    test('string concat', () => valid("request.auth.uid + '_' + request.resource.data.postId"));
    test('nested null check + access', () => valid("request.auth != null && request.auth.token.email_verified == true"));
    test('ternary with unary', () => valid('a > 0 ? a : -a'));
    test('parenthesized subexpr', () => valid('(a || b) && (c || d)'));
  });

  // --- Invalid expressions ---
  describe('invalid expressions', () => {
    test('empty', () => invalid(''));
    test('dangling operator', () => invalid('=='));
    test('incomplete member', () => invalid('request.'));
    test('unclosed paren', () => invalid('(a + b'));
    test('unclosed bracket', () => invalid("data['field"));
    test('unclosed list', () => invalid('[1, 2'));
    test('double operator', () => invalid('a == == b'));
  });
});
