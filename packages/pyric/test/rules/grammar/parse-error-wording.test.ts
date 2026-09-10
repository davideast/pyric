import { describe, test, expect } from 'bun:test';
import { parseErrorWording } from '../../../src/rules/grammar/parse-error-wording.js';

/** The alternatives the grammar reports when a statement is unterminated. */
const TERMINATOR_SET =
  '";", "[", ".", "%", "/", "*", "<", ">", "<=", ">=", "-", "+", "is", "in", "!=", "==", "&&", "?", or "||"';

const SOURCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{id} {
      allow read: if true
    }
  }
}`;

describe('parseErrorWording', () => {
  test('names the statement a missing terminator belongs to', () => {
    expect(parseErrorWording({ line: 5, column: 26, expected: TERMINATOR_SET }, SOURCE)).toBe(
      "expected ';' after the allow statement",
    );
  });

  test('names the binding a missing terminator belongs to', () => {
    const source = 'function f() {\n  let owner = resource.data.owner\n  return true;\n}';
    expect(parseErrorWording({ line: 2, column: 33, expected: TERMINATOR_SET }, source)).toBe(
      "expected ';' after the let binding",
    );
  });

  test('names the version line an unterminated header belongs to', () => {
    expect(parseErrorWording({ line: 2, column: 1, expected: TERMINATOR_SET }, "rules_version = '2'\n")).toBe(
      "expected ';' after the version line",
    );
  });

  test('falls back to the end of the statement when no line nearby names a construct', () => {
    const source = 'service cloud.firestore {\n  match /a/{b} {\n  }\n}';
    expect(parseErrorWording({ line: 3, column: 3, expected: TERMINATOR_SET }, source)).toBe(
      "expected ';' at the end of the statement",
    );
  });

  test('keeps a set short enough to read as the vocabulary it is', () => {
    const verbs = '"delete", "update", "create", "list", "get", "write", or "read"';
    expect(parseErrorWording({ line: 4, column: 20, expected: verbs }, SOURCE)).toBe(
      `expected ${verbs}`,
    );
  });

  test('says syntax error when the set is the parser state rather than an edit', () => {
    const state =
      '"[", ".", "%", "/", "*", "<", ">", "<=", ">=", "-", "+", "is", "in", "!=", "==", "&&", "?", or "||"';
    expect(parseErrorWording({ line: 5, column: 26, expected: state }, SOURCE)).toBe('syntax error');
  });
});
