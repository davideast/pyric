/**
 * Bytes literal grammar. The accepted and rejected forms match the
 * production Rules Test API, captured through the Firestore corpus scenario
 * bytes-toutf8-and-hashing and the Storage corpus scenario bytes-literal and
 * probed form by form: a `b` or `B` prefix directly before a single- or
 * double-quoted body, whose characters encode as UTF-8 and whose escapes
 * are `\\ \' \" \n \r \t \b \f`, `\x` with two hexadecimal digits, and `\`
 * with three octal digits up to `\377`.
 */
import { describe, expect, test } from 'bun:test';
import { parseExpression, parseToASTOrError } from '../../../src/rules/grammar/FirestoreParser.js';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if ${condition}; }
  }
}`;
}

function literalOf(source: string): Expression {
  const parsed = parseToASTOrError(rules(`${source} == null`));
  if (!parsed.ok) throw new Error(parsed.error.message);
  const condition = parsed.ast.service.match.children[0]!.allows[0]!.condition;
  if (condition.type !== 'binaryOp') throw new Error(`unexpected condition ${condition.type}`);
  return condition.left;
}

function bytesOf(source: string): number[] {
  const literal = literalOf(source);
  if (literal.type !== 'literal' || !(literal.value instanceof Uint8Array)) {
    throw new Error(`${source} did not parse to a bytes literal`);
  }
  return [...literal.value];
}

describe('bytes literal: accepted forms', () => {
  const accepted: Array<[string, number[]]> = [
    ["b'abc'", [0x61, 0x62, 0x63]],
    ['b"abc"', [0x61, 0x62, 0x63]],
    ["B'abc'", [0x61, 0x62, 0x63]],
    ['B"abc"', [0x61, 0x62, 0x63]],
    ["b''", []],
    ['b"it\'s"', [0x69, 0x74, 0x27, 0x73]],
    ["b'\\x00\\x01'", [0x00, 0x01]],
    ["b'\\xFf\\xfF'", [0xff, 0xff]],
    ["b'\\x411'", [0x41, 0x31]],
    ["b'\\101'", [0x41]],
    ["b'\\012'", [0x0a]],
    ["b'\\377'", [0xff]],
    ["b'\\000'", [0x00]],
    ["b'\\\\\\'\\\"\\n\\r\\t\\b\\f'", [0x5c, 0x27, 0x22, 0x0a, 0x0d, 0x09, 0x08, 0x0c]],
    ["b'é'", [0xc3, 0xa9]],
    ["b'日本'", [0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac]],
    ["b'\\xe9'", [0xe9]],
  ];

  for (const [source, expected] of accepted) {
    test(`${source} parses to ${JSON.stringify(expected)}`, () => {
      expect(parseExpression(source).valid).toBe(true);
      expect(bytesOf(source)).toEqual(expected);
    });
  }

  test('the literal keeps its source text for printers', () => {
    const literal = literalOf("B\"a\\x00\"");
    expect(literal.type === 'literal' && literal.raw).toBe('B"a\\x00"');
  });

  test('a bytes literal composes with methods, comparisons, lists, and hashing', () => {
    for (const source of [
      "b'abc' == 'abc'.toUtf8()",
      "b'\\x00\\x01'.size() == 2",
      "b'abc' < b'abd'",
      "b'abc' in [b'abc']",
      "hashing.md5(b'abc') == hashing.md5('abc')",
      "b'abc' is bytes",
    ]) {
      expect(parseToASTOrError(rules(source)).ok).toBe(true);
    }
  });

  test('an identifier named b still parses', () => {
    expect(parseExpression('b == 1').valid).toBe(true);
    expect(parseExpression('b.size() == 1').valid).toBe(true);
    expect(parseExpression("B + 'x'").valid).toBe(true);
  });
});

describe('bytes literal: forms production rejects', () => {
  const rejected = [
    "b'\\u0041'",
    "b'\\u00e9'",
    "b'\\U0001F600'",
    "b'\\/'",
    "b'\\a'",
    "b'\\v'",
    "b'\\?'",
    "b'\\d'",
    "b'\\X41'",
    "b'\\x0'",
    "b'\\xZZ'",
    "b'\\0'",
    "b'\\12'",
    "b'\\400'",
    "b'\\777'",
    "b'a\nb'",
    "b'a\rb'",
    "b 'abc'",
    "rb'abc'",
    "br'abc'",
    "bb'abc'",
  ];

  for (const source of rejected) {
    test(`${JSON.stringify(source)} is a parse error`, () => {
      expect(parseToASTOrError(rules(`${source}.size() == 1`)).ok).toBe(false);
    });
  }
});
