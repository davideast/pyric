/**
 * Errors as values in the Storage evaluator, against production's captures
 * in the functions-let-scope and error-absorption-and-direction scenarios of
 * the Storage rules corpus, the twin of the Firestore simulator's
 * test/rules/simulator/error-values.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../../../conformance/rules-corpus/storage/index.ts';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { DIVIDE_BY_ZERO_MESSAGE } from '../../../src/rules/simulator/eval-error.js';
import { normalizeStoragePath, type StorageTestCase } from '../../../src/rules/test/spec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATIONS = join(HERE, '..', '..', '..', '..', 'conformance', 'observations', 'storage-rules');

function scenario(id: string) {
  const s = ALL_RULES_STORAGE_SCENARIOS.find((x) => x.id === id)!;
  const observation = JSON.parse(readFileSync(join(OBSERVATIONS, `rules-storage-${id}.json`), 'utf8')) as {
    behavior: Record<string, string>;
    diagnostics: Record<string, { notes: string[] }>;
  };
  const rules = parseStorageRules(s.rules);
  const caseAt = (folder: string): StorageTestCase => s.cases.find((c) => c.path.startsWith(`${folder}/`))!;
  const evaluate = (tc: StorageTestCase) => evaluateStorageRules(rules, {
    request: {
      auth: tc.auth ?? null,
      method: tc.method,
      path: normalizeStoragePath(tc.path),
      ...(tc.resource ? { resource: { size: tc.resource.size ?? 0, contentType: tc.resource.contentType, metadata: tc.resource.metadata } } : {}),
    },
    resource: null,
  });
  return { observation, caseAt, evaluate };
}

describe('an error bound to a parameter or let decides only where it is read', () => {
  const { observation, caseAt, evaluate } = scenario('functions-let-scope');
  for (const folder of [
    'argUnread', 'argRead', 'argThroughTwoCallsUnread', 'argThroughTwoCallsRead',
    'argMethodErrorUnread', 'letUnread', 'letRead',
  ]) {
    test(`${folder}: decides as production did`, () => {
      const tc = caseAt(folder);
      expect(evaluate(tc).allowed ? 'ALLOW' : 'DENY').toBe(observation.behavior[tc.description]!);
    });
  }

  test('a read binding raises the argument\'s own error', () => {
    expect(evaluate(caseAt('argThroughTwoCallsRead')).reasons[0]).toEndWith(DIVIDE_BY_ZERO_MESSAGE);
  });
});

describe('operands after an error', () => {
  const { observation, caseAt, evaluate } = scenario('error-absorption-and-direction');

  for (const folder of ['divideByRequestZeroDeny', 'moduloByRequestZeroDeny']) {
    test(`${folder}: production's message`, () => {
      const tc = caseAt(folder);
      expect(observation.diagnostics[tc.description]!.notes[0]).toEndWith(DIVIDE_BY_ZERO_MESSAGE);
      expect(evaluate(tc).reasons[0]).toEndWith(DIVIDE_BY_ZERO_MESSAGE);
    });
  }

  for (const folder of ['firstErrorEq', 'firstErrorList', 'firstErrorIn', 'firstErrorMethodArgs', 'firstErrorReceiver']) {
    test(`${folder}: reports the error production reported`, () => {
      const tc = caseAt(folder);
      const production = observation.diagnostics[tc.description]!.notes[0]!.replace(/^Error: \S+ line \[\d+\], column \[\d+\]\. /, '');
      const result = evaluate(tc);
      expect(result.allowed).toBe(false);
      expect(result.reasons[0]).toEndWith(production);
    });
  }

  test('an operand past the limit after an error in the same expression is reported as the limit', () => {
    const tc = caseAt('errThenOperandOverLimitDeny');
    expect(observation.diagnostics[tc.description]!.notes[0]).toContain('maximum of 1000 expressions');
    const result = evaluate(tc);
    expect(result.allowed).toBe(false);
    expect(result.resourceLimit?.kind).toBe('expressions');
  });
});
