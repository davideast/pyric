/**
 * String literal escapes. The accepted and rejected forms match the
 * production Rules Test API, captured through the string escape cases of the
 * Firestore corpus scenario string-literals-and-regex and the Storage corpus
 * scenario stdlib-string-bytes-hashing and probed form by form.
 *
 * A backslash escapes a backslash, either quote, `n`, `r`, `t`, `b`, or `f`.
 * `\x` takes exactly two hexadecimal digits and `\` takes three octal digits
 * up to `\377`; each is the code point of that value, not a byte. `\u` takes
 * exactly four hexadecimal digits and is one UTF-16 code unit. Every other
 * escape is a parse error, including `\/`, and so is a raw line break inside
 * the quotes.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseExpression,
  parseToASTOrError,
} from '../../../src/rules/grammar/FirestoreParser.js';

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if ${condition}; }
  }
}`;
}

function stringOf(source: string): string {
  const parsed = parseToASTOrError(rules(`x == ${source}`));
  if (!parsed.ok) throw new Error(parsed.error.message);
  const condition = parsed.ast.service.match.children[0]!.allows[0]!.condition;
  if (condition.type !== 'binaryOp') throw new Error(`unexpected condition ${condition.type}`);
  const literal = condition.right;
  if (literal.type !== 'literal' || typeof literal.value !== 'string') {
    throw new Error(`${source} did not parse to a string literal`);
  }
  return literal.value;
}

describe('string escapes: accepted forms', () => {
  const accepted: Array<[string, string, string]> = [
    ['backslash', "'a\\\\b'", 'a\\b'],
    ['single quote', "'a\\'b'", "a'b"],
    ['double quote', "'a\\\"b'", 'a"b'],
    ['newline', "'a\\nb'", 'a\nb'],
    ['carriage return', "'a\\rb'", 'a\rb'],
    ['tab', "'a\\tb'", 'a\tb'],
    ['backspace', "'a\\bb'", 'a\bb'],
    ['form feed', "'a\\fb'", 'a\fb'],
    ['hex escape', "'\\x41'", 'A'],
    ['hex escape, either case', "'\\x4a\\x4A'", 'JJ'],
    ['hex escape takes two digits', "'\\x411'", 'A1'],
    ['hex escape is a code point', "'\\xe9'", String.fromCharCode(0xe9)],
    ['hex escapes are not UTF-8 decoded', "'\\xc3\\xa9'", String.fromCharCode(0xc3, 0xa9)],
    ['unicode escape', "'\\u0041'", 'A'],
    ['unicode escape, either case', "'\\u00e9\\u00E9'", String.fromCharCode(0xe9, 0xe9)],
    ['unicode escape takes four digits', "'\\u00411'", 'A1'],
    ['unicode escape outside Latin-1', "'\\u65e5\\u672c'", String.fromCharCode(0x65e5, 0x672c)],
    ['unicode surrogate pair', "'\\ud83d\\ude00'", String.fromCharCode(0xd83d, 0xde00)],
    ['unicode NUL', "'\\u0000'", String.fromCharCode(0)],
    ['octal escape', "'\\101'", 'A'],
    ['octal escape for a line feed', "'\\012'", '\n'],
    ['octal NUL', "'\\000'", String.fromCharCode(0)],
    ['largest octal escape', "'\\377'", String.fromCharCode(0xff)],
    ['double-quoted mix', '"\\x41\\u0041\\101"', 'AAA'],
    ['raw tab', "'a\tb'", 'a\tb'],
    ['non-ASCII character', "'日本'", '日本'],
  ];

  for (const [name, source, expected] of accepted) {
    test(`${name}: ${source} decodes to ${JSON.stringify(expected)}`, () => {
      expect(parseExpression(source).valid).toBe(true);
      expect(stringOf(source)).toBe(expected);
    });
  }

  test('the literal keeps its source text for printers', () => {
    const parsed = parseToASTOrError(rules("x == '\\x41\\u0041'"));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const condition = parsed.ast.service.match.children[0]!.allows[0]!.condition;
    expect(condition.type === 'binaryOp' && condition.right.type === 'literal' && condition.right.raw)
      .toBe("'\\x41\\u0041'");
  });

  test("matches('.*@acme\\\\.com') parses: source `\\\\.` is the value `\\.`", () => {
    expect(parseToASTOrError(rules("request.auth.token.email.matches('.*@acme\\\\.com')")).ok).toBe(true);
    expect(stringOf("'.*@acme\\\\.com'")).toBe('.*@acme\\.com');
  });
});

describe('string escapes: forms production rejects', () => {
  const rejected: Array<[string, string]> = [
    ['escaped slash', "'\\/'"],
    ['bell', "'\\a'"],
    ['vertical tab', "'\\v'"],
    ['question mark', "'\\?'"],
    ['backtick', "'\\`'"],
    ['regex digit class', "'\\d'"],
    ['regex dot', "'\\.'"],
    ['regex word class', "'\\w'"],
    ['one octal digit', "'\\0'"],
    ['two octal digits', "'\\12'"],
    ['octal above 377', "'\\400'"],
    ['hex with one digit', "'\\x4'"],
    ['hex with a non-hex digit', "'\\x4g'"],
    ['uppercase X', "'\\X41'"],
    ['bare u', "'\\u'"],
    ['unicode with three digits', "'\\u041'"],
    ['unicode with non-hex digits', "'\\uzzzz'"],
    ['braced unicode', "'\\u{41}'"],
    ['uppercase U with eight digits', "'\\U0001F600'"],
    ['uppercase U for A', "'\\U00000041'"],
    ['raw line feed, single-quoted', "'a\nb'"],
    ['raw line feed, double-quoted', '"a\nb"'],
    ['raw carriage return', "'a\rb'"],
    ['lone backslash before the end', "'a\\"],
  ];

  for (const [name, source] of rejected) {
    test(`${name}: ${JSON.stringify(source)} is a parse error`, () => {
      expect(parseToASTOrError(rules(`${source}.size() == 1`)).ok).toBe(false);
    });
  }

  test('the diagnostic points inside the string literal', () => {
    const parsed = parseToASTOrError(rules("request.auth.token.email.matches('.*@acme\\.com')"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.line).toBeGreaterThanOrEqual(4);
  });
});
