/**
 * Errors as values in the Firestore simulator, against production's
 * captures in the error-absorption-and-or scenario of the Firestore rules
 * corpus.
 *
 * An argument or `let` value that errors is bound and the function body
 * runs; the error decides the verdict only where the body reads it. The
 * operands of a non-logical operator, a literal's elements, and a call's
 * receiver and arguments all evaluate after one errors, and the result is
 * the first error in production's order, which the capture's diagnostics
 * name.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../../../conformance/rules-corpus/firestore/index.ts';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { DIVIDE_BY_ZERO_MESSAGE } from '../../../src/rules/simulator/eval-error.js';
import type { TestCase, TestResult } from '../../../src/rules/test/spec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenario = ALL_RULES_FIRESTORE_SCENARIOS.find((s) => s.id === 'error-absorption-and-or')!;
const observation = JSON.parse(readFileSync(join(
  HERE, '..', '..', '..', '..', 'conformance', 'observations', 'firestore-rules', 'rules-firestore-error-absorption-and-or.json',
), 'utf8')) as { behavior: Record<string, string>; diagnostics: Record<string, { notes: string[] }> };

function simulate(tc: TestCase): TestResult {
  const res = new SimulateFirestoreRulesHandler().simulate(scenario.rules, [tc]);
  if (!res.success) throw new Error(res.error.message);
  return res.data.results[0]!;
}

function caseAt(collection: string): TestCase {
  const tc = scenario.cases.find((c) => c.path === `${collection}/d1`);
  if (!tc) throw new Error(`no case for ${collection}`);
  return tc;
}

describe('an error bound to a parameter or let decides only where it is read', () => {
  for (const collection of [
    'argUnreadAllow', 'argReadDeny', 'argThroughTwoCallsUnreadAllow', 'argThroughTwoCallsReadDeny',
    'argMissingFieldUnreadAllow', 'letUnreadAllow', 'letReadDeny',
  ]) {
    test(`${collection}: decides as production did`, () => {
      const tc = caseAt(collection);
      expect(simulate(tc).decision).toBe(observation.behavior[tc.description]);
    });
  }

  test('a read binding raises the argument\'s own error', () => {
    const result = simulate(caseAt('argThroughTwoCallsReadDeny'));
    expect(result.trace[0]!.message).toBe(DIVIDE_BY_ZERO_MESSAGE);
  });
});

describe('int division and modulo by zero', () => {
  for (const collection of ['divideByDataZeroDeny', 'moduloByDataZeroDeny']) {
    test(`${collection}: production's message`, () => {
      const tc = caseAt(collection);
      expect(observation.diagnostics[tc.description]!.notes[0]).toEndWith(DIVIDE_BY_ZERO_MESSAGE);
      expect(simulate(tc).trace[0]!.message).toBe(DIVIDE_BY_ZERO_MESSAGE);
    });
  }
});

describe('the first of two errors is the one production reports', () => {
  for (const collection of [
    'firstErrorEq', 'firstErrorPlus', 'firstErrorList', 'firstErrorMap', 'firstErrorIn',
    'firstErrorMethodArgs', 'firstErrorReceiver', 'firstErrorFunctionArgs',
  ]) {
    test(`${collection}: names the field production named`, () => {
      const tc = caseAt(collection);
      const field = /Property (\w+) is undefined/.exec(observation.diagnostics[tc.description]!.notes[0]!)![1]!;
      const result = simulate(tc);
      expect(result.decision).toBe('DENY');
      expect(result.trace[0]!.message).toContain(`'${field}'`);
    });
  }
});

describe('operands after an error count toward the expression limit', () => {
  test('an operand past the limit after an error in the same expression is reported as the limit', () => {
    const tc = caseAt('errThenOperandOverLimitDeny');
    expect(observation.diagnostics[tc.description]!.notes[0]).toContain('maximum of 1000 expressions');
    const result = simulate(tc);
    expect(result.decision).toBe('DENY');
    expect(result.resourceLimit?.kind).toBe('expressions');
  });

  test('both operands of == evaluate when the left one errors', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} { allow get: if resource.data.missing == [1, 2, 3]; }
  }
}`;
    const res = new SimulateFirestoreRulesHandler().simulate(rules, [
      { description: 'd', expectation: 'DENY', method: 'get', path: 't/x', resource: { a: 1 } },
    ]);
    if (!res.success) throw new Error(res.error.message);
    // == (1), resource.data.missing (3), and [1, 2, 3] (4).
    expect(res.data.results[0]!.evaluatedExpressions).toBe(8);
  });
});
