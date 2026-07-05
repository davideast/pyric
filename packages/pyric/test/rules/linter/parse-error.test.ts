/**
 * Tests for the linter's structured parse-error surface.
 *
 * The contract: when source doesn't parse, `lintFirestoreRules` returns
 * `parseError` populated with line/column/expected info, and budget-rule
 * warnings + metrics are zeroed out (sourceSize is the only meaningful
 * metric in this state).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

describe('lintFirestoreRules — structured parse error', () => {
  test('valid source: parseError is undefined', () => {
    const r = lintFirestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function isAuth() { return request.auth != null; }
    match /x/{id} { allow read: if isAuth(); }
  }
}`);
    expect(r.parseError).toBeUndefined();
    expect(r.metrics.functionCount).toBe(1);
  });

  test('one-line broken source: parseError populated, metrics zeroed', () => {
    const r = lintFirestoreRules('this is not rules');
    expect(r.parseError).toBeDefined();
    expect(r.parseError!.line).toBe(1);
    expect(r.parseError!.column).toBeGreaterThan(0);
    expect(r.parseError!.message.length).toBeGreaterThan(0);
    expect(r.metrics.functionCount).toBe(0);
    expect(r.metrics.allowRuleCount).toBe(0);
    // sourceSize stays meaningful — it doesn't depend on parsing.
    expect(r.metrics.sourceSize).toBe('this is not rules'.length);
  });

  test('valid first line then garbage: parseError points past the valid prefix', () => {
    const src = `rules_version = '2';\n@@@ not valid @@@`;
    const r = lintFirestoreRules(src);
    expect(r.parseError).toBeDefined();
    expect(r.parseError!.line).toBeGreaterThanOrEqual(2);
  });

  test('legacy PARSE_ERROR warning is no longer emitted', () => {
    const r = lintFirestoreRules('not a rules file');
    expect(r.warnings.some(w => w.rule === 'PARSE_ERROR')).toBe(false);
  });

  test('source-size warning still fires on oversized garbage', () => {
    const big = 'x'.repeat(300 * 1024); // > 256 KB
    const r = lintFirestoreRules(big);
    expect(r.parseError).toBeDefined();
    expect(r.warnings.some(w => w.rule === 'SOURCE_SIZE')).toBe(true);
  });
});

describe('lintFirestoreRules — pathClear regression fixture', () => {
  // A multi-line rules file modeled on a real agent-generated chess failure:
  // an unclosed parenthesis inside `pathClear()`. Ohm reports the rightmost
  // failure (where the grammar gave up), not the original missing paren —
  // the test asserts what's actually useful: the failure is in the pathClear
  // region, expects a closing paren, and the message points at a real line.
  const src = readFileSync(join(FIXTURES, 'parse-error-pathclear.rules'), 'utf-8');

  test('parses to a structured parseError, not a null AST', () => {
    const r = lintFirestoreRules(src);
    expect(r.parseError).toBeDefined();
  });

  test('expected text mentions a closing token', () => {
    const r = lintFirestoreRules(src);
    expect(r.parseError!.expected).toContain(')');
  });

  test('failure is in the pathClear region (lines ~85–100)', () => {
    const r = lintFirestoreRules(src);
    expect(r.parseError!.line).toBeGreaterThanOrEqual(85);
    expect(r.parseError!.line).toBeLessThanOrEqual(100);
  });

  test('actual snippet is a non-empty fragment of the failing region', () => {
    const r = lintFirestoreRules(src);
    expect(r.parseError!.actual.length).toBeGreaterThan(0);
  });

  test('full message preserves source context with line numbers', () => {
    const r = lintFirestoreRules(src);
    // ohm's multi-line message format: "Line N, col M:\n  N-1 | ...\n> N | ...\n  N+1 | ..."
    expect(r.parseError!.message).toContain('Line ');
    expect(r.parseError!.message).toContain('col ');
  });

  test('budget-rule warnings are skipped (metrics zeroed)', () => {
    const r = lintFirestoreRules(src);
    expect(r.metrics.functionCount).toBe(0);
    expect(r.metrics.maxChainDepth).toBe(0);
    expect(r.warnings.some(w => w.rule === 'PARSE_ERROR')).toBe(false);
  });
});
