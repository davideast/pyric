/**
 * Deeply nested source never exhausts the parser's stack. Past 98
 * parenthesized groups production rejects the ruleset as too complex, so the
 * parser does not descend into a group nested deeper than that; past the
 * parser's bracket depth bound it reports a parse error.
 */
import { describe, expect, test } from 'bun:test';
import { parseExpression, parseRulesFile, parseToASTOrError } from '../../../src/rules/grammar/FirestoreParser.js';
import { MAX_BRACKET_DEPTH } from '../../../src/rules/grammar/bracket-scan.js';
import { NESTING_MESSAGE, compileLimitViolations } from '../../../src/rules/grammar/compile-limits.js';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';
import { firestoreRules } from '../../../src/rules/api/firestore.js';
import { RulesCompileError } from '../../../src/rules/api/errors.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';

function firestore(condition: string, extra = ''): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${extra}    match /p/{d} {\n      allow read: if ${condition};\n    }\n  }\n}\n`;
}

function storage(condition: string): string {
  return `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /p/{d} {\n      allow read: if ${condition};\n    }\n  }\n}\n`;
}

const groups = (n: number, inner = "request.auth.uid == 'a'") => `${'('.repeat(n)}${inner}${')'.repeat(n)}`;

function nesting(source: string): number {
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) throw new Error(`did not parse: ${parsed.error.message}`);
  return compileLimitViolations(parsed.ast).filter((v) => v.code === 'NESTING_DEPTH').length;
}

describe('parser: nested parenthesized groups', () => {
  test('300 nested groups parse and are rejected once as too complex, as production rejects 100 or more', () => {
    expect(nesting(firestore(groups(300)))).toBe(1);
  });

  test('10000 nested groups parse without exhausting the stack', () => {
    expect(nesting(firestore(groups(10_000)))).toBe(1);
  });

  test('the counts at the boundary are unchanged: 97 compile, 98 report two, 99 and 100 report one', () => {
    expect([97, 98, 99, 100].map((n) => nesting(firestore(groups(n))))).toEqual([0, 2, 1, 1]);
  });

  test('a group nested past the cutoff inside an operator chain is reported once per rule', () => {
    expect(nesting(firestore(`a == 1 && ${groups(300)} && b == 2`))).toBe(1);
  });

  test('parseRulesFile and parseExpression accept 300 nested groups without throwing', () => {
    expect(parseRulesFile(firestore(groups(300))).valid).toBe(true);
    expect(parseExpression(groups(300)).valid).toBe(true);
  });

  test('unbalanced opening parentheses report a parse error, not a stack overflow', () => {
    const parsed = parseToASTOrError(firestore('('.repeat(300) + 'true'));
    expect(parsed.ok).toBe(false);
  });

  test('line numbers after a nested group spanning lines are unchanged', () => {
    const source = firestore(groups(300, "request.auth.uid\n == 'a'"))
      .replace('    }\n  }\n}\n', '    }\n    match /q/{d} {\n      allow read: if true;\n    }\n  }\n}\n');
    const parsed = parseToASTOrError(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.ast.service.match.children.map((m) => m.allows[0]!.loc!.line)).toEqual([5, 9]);
  });
});

describe('parser: what the group scan does not count', () => {
  test('parentheses inside a string literal are not groups', () => {
    const quoted = '('.repeat(300);
    expect(nesting(firestore(`request.auth.uid == '${quoted}'`))).toBe(0);
    expect(nesting(firestore(`request.auth.uid == "${quoted}"`))).toBe(0);
    expect(nesting(firestore(`request.auth.uid == '\\'${quoted}'`))).toBe(0);
  });

  test('parentheses inside a comment are not groups', () => {
    expect(nesting(firestore("request.auth.uid == 'a'", `    // ${'('.repeat(300)}\n    /* ${'('.repeat(300)} */\n`))).toBe(0);
  });

  test('a quote inside a comment does not start a string', () => {
    expect(nesting(firestore(groups(300), "    // it's a comment\n"))).toBe(1);
  });

  test('function call parentheses are not groups: 110 nested calls around a comparison compile', () => {
    const calls = `${'f('.repeat(110)}request.auth.uid == 'a'${')'.repeat(110)}`;
    expect(nesting(firestore(calls, '    function f(x) { return x; }\n'))).toBe(0);
  });

  test('method call and path interpolation parentheses are not groups', () => {
    const methods = `${"'a'.concat(".repeat(110)}'a'${')'.repeat(110)} == 'a'`;
    expect(nesting(firestore(methods))).toBe(0);
    const path = `exists(/databases/$(database)/documents/p/$(request.auth.uid))`;
    expect(nesting(firestore(path))).toBe(0);
  });

  test('parentheses after `if`, `return` and `in` are groups', () => {
    expect(nesting(firestore(`request.auth.uid in ${groups(300, "['a']")}`))).toBe(1);
    const fn = `    function g() { return ${groups(300, 'true')}; }\n`;
    const parsed = parseToASTOrError(firestore('g()', fn));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(compileLimitViolations(parsed.ast).map((v) => v.functionName)).toEqual(['g']);
  });
});

describe('parser: the bracket depth bound', () => {
  test(`brackets nested past ${MAX_BRACKET_DEPTH} levels are a parse error, not a stack overflow`, () => {
    for (const expr of [
      `${'['.repeat(300)}1${']'.repeat(300)} == 1`,
      `${"{'a': ".repeat(300)}1${'}'.repeat(300)} == 1`,
      `${'f('.repeat(300)}1${')'.repeat(300)}`,
      `a${'[a'.repeat(300)}${']'.repeat(300)}`,
    ]) {
      const parsed = parseToASTOrError(firestore(expr));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.message).toContain(`more than ${MAX_BRACKET_DEPTH} levels`);
        expect(parsed.error.line).toBe(5);
      }
    }
  });

  test('a long run of unary operators is a parse error, not a stack overflow', () => {
    const parsed = parseToASTOrError(firestore(`${'!'.repeat(20_000)}true`));
    expect(parsed.ok).toBe(false);
  });
});

describe('engines and the linter on 300 nested groups', () => {
  test('firestoreRules rejects with the production message', () => {
    let error: unknown;
    try {
      firestoreRules(firestore(groups(300)));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RulesCompileError);
    expect((error as RulesCompileError).issues.map((i) => [i.code, i.message])).toEqual([['NESTING_DEPTH', NESTING_MESSAGE]]);
  });

  test('parseStorageRules rejects with the production message', () => {
    expect(() => parseStorageRules(storage(groups(300)))).toThrow(`Storage rules do not compile: Line 5: ${NESTING_MESSAGE}`);
  });

  test('the linter reports NESTING_DEPTH', () => {
    const result = lintFirestoreRules(firestore(groups(300)));
    expect(result.warnings.filter((w) => w.rule === 'NESTING_DEPTH')).toHaveLength(1);
  });
});
