/**
 * String-escape strictness tests — `matches-string-escape-strict` from
 * REBUILD_PLAN.md (Class B Bugs). The grammar restricts the set of
 * characters that may follow a backslash in a string literal to match
 * production semantics: production raises a syntax error on `\d`, `\.`,
 * `\w`, etc. Pre-fix the simulator silently accepted these — that masked
 * model output that would crash at deploy.
 *
 * The valid set is `\\ \' \" \n \r \t \/`. Anything else is rejected at
 * parse time with a structured ParseError.
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

describe('string escapes — accepted (production-valid)', () => {
  // These are the seven escape sequences the grammar's stringEscapeChar
  // rule whitelists. Each must round-trip through parse → AST → runtime
  // without diagnostic.
  const accepted: Array<[string, string, string]> = [
    ['backslash',     "'a\\\\b'",  'a\\b'],   // source `\\`  → value `\`
    ['single-quote',  "'a\\'b'",   "a'b"],    // source `\'`  → value `'`
    ['double-quote',  "'a\\\"b'",  'a"b'],    // source `\"`  → value `"`
    ['newline',       "'a\\nb'",   'a\nb'],
    ['carriage ret',  "'a\\rb'",   'a\rb'],
    ['tab',           "'a\\tb'",   'a\tb'],
    ['forward slash', "'a\\/b'",   'a/b'],
  ];

  for (const [name, src, expected] of accepted) {
    test(`${name}: ${src} parses and decodes to ${JSON.stringify(expected)}`, () => {
      const r = parseExpression(src);
      expect(r.valid).toBe(true);
      // Confirm the runtime value (after escape processing) matches.
      const ast = parseToASTOrError(rules(`x == ${src}`));
      expect(ast.ok).toBe(true);
      if (ast.ok) {
        const cond = ast.ast.service.match.children[0]!.allows[0]!.condition;
        // condition is binaryOp ==; right side is the string literal.
        expect((cond as any).right.value).toBe(expected);
      }
    });
  }

  test('double-quoted form accepts the same escape set', () => {
    expect(parseExpression('"a\\nb"').valid).toBe(true);
    expect(parseExpression('"a\\\\b"').valid).toBe(true);
    expect(parseExpression('"a\\"b"').valid).toBe(true);
  });

  test('regression: `.matches(\'.*@acme\\\\.com\')` still parses', () => {
    // The matches-string-escape pack source. Source `\\.` → value `\.`.
    const r = parseToASTOrError(rules(
      "request.auth.token.email.matches('.*@acme\\\\.com')",
    ));
    expect(r.ok).toBe(true);
  });
});

describe('string escapes — rejected (production-invalid)', () => {
  // Any backslash NOT followed by one of the whitelisted chars must fail
  // the parse with a structured ParseError. These are the cases that
  // pre-fix slipped through silently.
  const rejected = ['.', 'd', 'w', 's', 'D', 'W', 'S', 'b', 'f', 'v', 'x', '0', 'a'];

  for (const ch of rejected) {
    test(`'\\${ch}' is rejected at parse time`, () => {
      const src = `'a\\${ch}b'`;
      const r = parseExpression(src);
      expect(r.valid).toBe(false);
      expect(r.parseError).toBeDefined();
      // Diagnostic should point near the offending escape character.
      // Offset is into the trimmed source; the escape lives at index 2
      // (after the opening quote and the leading 'a').
      expect(r.parseError!.offset).toBeGreaterThanOrEqual(2);
    });
  }

  test('full rules file with `\\.` in matches() fails to parse', () => {
    // This is the regex-style escape models sometimes emit. Pre-fix the
    // simulator silently accepted it; production rejects at parse time.
    const r = parseToASTOrError(rules(
      "request.auth.token.email.matches('.*@acme\\.com')",
    ));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Should pinpoint inside the string literal, not at end-of-file.
      expect(r.error.line).toBeGreaterThanOrEqual(4);
    }
  });

  test('double-quoted form rejects the same set', () => {
    expect(parseExpression('"a\\db"').valid).toBe(false);
    expect(parseExpression('"a\\.b"').valid).toBe(false);
  });

  test('lone trailing backslash before close quote is rejected', () => {
    // `'a\'` — the `\'` is a valid escape, but then the string never
    // closes. `'a\\'` is fine (escaped backslash + close). `'a\X'` for
    // any disallowed X is rejected as above. This test covers the
    // pathological `'a\\` where the escape consumes the would-be close.
    expect(parseExpression("'a\\").valid).toBe(false);
  });
});
