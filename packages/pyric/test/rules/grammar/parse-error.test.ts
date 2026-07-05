/**
 * Tests for structured parse-error surfacing in the Firestore parser.
 * Covers parseRulesFile (legacy ParseResult shape with new parseError field)
 * and parseToASTOrError (new structured-failure entry point).
 */
import { describe, expect, test } from 'bun:test';
import {
  parseRulesFile,
  parseToAST,
  parseToASTOrError,
} from '../../../src/rules/grammar/FirestoreParser.js';

describe('parseRulesFile — structured failure', () => {
  test('valid source: parseError absent', () => {
    const r = parseRulesFile(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if true; }
  }
}`);
    expect(r.valid).toBe(true);
    expect(r.parseError).toBeUndefined();
  });

  test('unclosed paren: parseError populated with line/column', () => {
    // Line 4 has a missing closing paren after 'true'.
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if (true; }
  }
}`;
    const r = parseRulesFile(src);
    expect(r.valid).toBe(false);
    expect(r.parseError).toBeDefined();
    expect(r.parseError!.line).toBeGreaterThanOrEqual(4);
    expect(r.parseError!.column).toBeGreaterThan(0);
    expect(r.parseError!.offset).toBeGreaterThan(0);
    // Legacy errors[0].message stays in sync with the structured message.
    expect(r.errors[0]!.message).toBe(r.parseError!.message);
  });

  test('expected text is non-empty when grammar has expectations', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read if true; }
  }
}`;
    const r = parseRulesFile(src);
    expect(r.valid).toBe(false);
    expect(r.parseError!.expected.length).toBeGreaterThan(0);
  });

  test('empty source: synthetic parse error', () => {
    const r = parseRulesFile('');
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toBe('Empty rules file');
    // Empty-source path bypasses ohm so parseError is not produced — that's OK.
    expect(r.parseError).toBeUndefined();
  });
});

describe('parseToASTOrError', () => {
  test('valid source returns ok=true with AST', () => {
    const r = parseToASTOrError(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if true; }
  }
}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.version).toBe('2');
      expect(r.ast.service.name).toBe('cloud.firestore');
    }
  });

  test('invalid source returns ok=false with structured error', () => {
    const r = parseToASTOrError(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if (true; }
  }
}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBeGreaterThanOrEqual(1);
      expect(r.error.column).toBeGreaterThan(0);
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });

  test('empty source returns synthetic error at 1:1', () => {
    const r = parseToASTOrError('');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBe(1);
      expect(r.error.column).toBe(1);
      expect(r.error.message).toBe('Empty rules file');
    }
  });
});

describe('parseToAST stays a thin wrapper', () => {
  test('valid: returns AST', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if true; }
  }
}`);
    expect(ast).not.toBeNull();
    expect(ast!.version).toBe('2');
  });

  test('invalid: returns null (callers needing diagnostics use parseToASTOrError)', () => {
    const ast = parseToAST('this is not rules');
    expect(ast).toBeNull();
  });
});
