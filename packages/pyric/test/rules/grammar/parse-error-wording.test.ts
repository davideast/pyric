import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseToASTOrError } from '../../../src/rules/grammar/FirestoreParser.js';
import { parseErrorWording } from '../../../src/rules/grammar/parse-error-wording.js';

/** The wording for the parse failure in `fixtures/parse-errors/<name>.rules`, as the parser reports it. */
function wordingOf(name: string): { line: number; column: number; wording: string } {
  const source = readFileSync(join(__dirname, 'fixtures/parse-errors', `${name}.rules`), 'utf-8');
  const parsed = parseToASTOrError(source);
  if (parsed.ok) throw new Error(`${name}.rules parsed; it is meant to fail`);
  return { line: parsed.error.line, column: parsed.error.column, wording: parseErrorWording(parsed.error, source) };
}

describe('parseErrorWording names the construct the parser was inside', () => {
  // Each fixture leaves out one terminator or brace. The failure is reported
  // at the token after the gap, which is often on a later line and often opens
  // a different construct, so the wording is read from the source before it.
  const positions: Array<[name: string, line: number, column: number, wording: string]> = [
    ['allow-on-one-line', 2, 87, "expected ';' after the allow statement"],
    ['allow-long-condition', 11, 5, "expected ';' after the allow statement"],
    ['let-before-return', 6, 7, "expected ';' after the let binding"],
    ['return-before-close', 6, 5, "expected ';' after the return expression"],
    ['version-line', 2, 1, "expected ';' after the version line"],
    ['unclosed-block-at-end', 7, 2, "expected '}' to close the service block opened at line 2"],
    ['unclosed-function-body', 6, 5, "expected '}' to close the function body opened at line 4"],
    ['match-without-brace', 5, 7, "expected '{' to open the match block"],
    ['function-without-brace', 5, 7, "expected '{' to open the function body"],
  ];

  for (const [name, line, column, wording] of positions) {
    test(`${name}: ${wording}`, () => {
      expect(wordingOf(name)).toEqual({ line, column, wording });
    });
  }
});

describe('parseErrorWording keeps or drops the expected set', () => {
  const SOURCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{id} {
      allow read: if true
    }
  }
}`;

  test('falls back to the end of the statement when no open statement precedes the gap', () => {
    const source = 'service cloud.firestore {\n  match /a/{b} {\n  }\n}';
    expect(parseErrorWording({ line: 3, column: 3, expected: '";"' }, source)).toBe(
      "expected ';' at the end of the statement",
    );
  });

  test('does not read a keyword inside a string or a field name as a statement', () => {
    const source = "service cloud.firestore {\n  match /a/{b} {\n    function f() { return resource.data.let == 'allow'; }\n  }\n}";
    expect(parseErrorWording({ line: 4, column: 3, expected: '";"' }, source)).toBe(
      "expected ';' at the end of the statement",
    );
  });

  test('keeps a set short enough to read as the vocabulary it is', () => {
    const verbs = '"delete", "update", "create", "list", "get", "write", or "read"';
    expect(parseErrorWording({ line: 4, column: 20, expected: verbs }, SOURCE)).toBe(`expected ${verbs}`);
  });

  test('says syntax error when the set is the parser state rather than an edit', () => {
    const state =
      '"[", ".", "%", "/", "*", "<", ">", "<=", ">=", "-", "+", "is", "in", "!=", "==", "&&", "?", or "||"';
    expect(parseErrorWording({ line: 5, column: 26, expected: state }, SOURCE)).toBe('syntax error');
  });
});
