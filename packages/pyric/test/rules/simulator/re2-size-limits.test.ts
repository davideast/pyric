/**
 * Firestore and Storage refuse a regex that expands past pyric's size
 * limits, the limits RTDB uses (#1261), instead of building a matcher that
 * exhausts memory (#1264). A literal is refused at compile with production's
 * refusal text and a sentence naming pyric's limit. A pattern from request
 * data is an evaluation error, which `|| true` absorbs and which denies on
 * its own. `a{1001}` is refused by RE2's repeat cap (ST-H3-10).
 *
 * Each refusal is bounded in time and heap, so a regression fails here
 * instead of killing the runner.
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/rules/api/firestore.js';
import { RulesCompileError } from '../../../src/rules/api/errors.js';
import { lint } from '../../../src/rules/api/lint.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { simulateDeployedRules } from '../../../src/firestore/sandbox/rules-simulator.js';
import type { TestCase } from '../../../src/rules/test/spec.js';
import { compileStorageRules } from '../../../src/storage/rules-resolution.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { scenario as firestoreRe2Scenario } from '../../../../conformance/rules-corpus/firestore/re2-pattern-semantics.ts';
import { scenario as storageRe2Scenario } from '../../../../conformance/rules-corpus/storage/h1-regex-re2-classes.ts';

const NESTED = '((a{1000}){1000}){1000}';
const OVER_REPEAT_CAP = 'a{1001}';
const CONTROLS = ['a{1000}', '(a{100}){100}', '(?<x>a)'];

const LIMIT_SENTENCE =
  "pyric refuses patterns that expand past 10,000 characters or 200,000 matcher states, a limit of pyric; " +
  "production's limit has not been measured.";

function invalid(pattern: string): string {
  return `Invalid regular expression pattern. Pattern: ${pattern}.`;
}

const TIME_BOUND_MS = 2000;
const HEAP_BOUND_BYTES = 100 * 1024 * 1024;

/** Run `work` and fail when it takes over two seconds or grows the heap past 100 MB. */
function bounded<T>(work: () => T): T {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = work();
  expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
  expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(HEAP_BOUND_BYTES);
  return result;
}

function firestoreSource(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /p/{id} { allow read, create: if ${condition}; }
  }
}`;
}

function storageSource(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read: if ${condition}; }
  }
}`;
}

function firestoreCompileMessages(source: string): string[] {
  try {
    firestoreRules(source);
  } catch (e) {
    if (e instanceof RulesCompileError) return e.issues.map((i) => i.message);
    throw e;
  }
  return [];
}

function storageCompileMessage(source: string): string | null {
  try {
    compileStorageRules(source);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('Firestore: regex literals past the size limit (#1264)', () => {
  const source = firestoreSource(`'a'.matches('${NESTED}')`);
  const message = `${invalid(NESTED)} ${LIMIT_SENTENCE}`;

  test('firestoreRules() refuses the nested repeat with the limit message', () => {
    expect(bounded(() => firestoreCompileMessages(source))).toContain(message);
  });

  test('lint() reports it as INVALID_REGEX_PATTERN', () => {
    const issues = bounded(() => lint(source));
    expect(issues.some((i) => i.code === 'INVALID_REGEX_PATTERN' && i.message === message)).toBe(true);
  });

  test('simulate() refuses the ruleset', () => {
    const result = bounded(() => new SimulateFirestoreRulesHandler().simulate(source, [
      { description: 'read', expectation: 'DENY', method: 'get', path: 'p/d1' } as TestCase,
    ]));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain(message);
  });

  test('a{1001} is refused at compile (ST-H3-10)', () => {
    const messages = bounded(() => firestoreCompileMessages(firestoreSource(`'a'.matches('${OVER_REPEAT_CAP}')`)));
    expect(messages).toContain(invalid(OVER_REPEAT_CAP));
  });

  for (const pattern of CONTROLS) {
    test(`${pattern} still compiles`, () => {
      expect(bounded(() => firestoreCompileMessages(firestoreSource(`'a'.matches('${pattern}')`)))).toEqual([]);
    });
  }

  test('every pattern in the RE2 semantics scenario still compiles', () => {
    expect(firestoreCompileMessages(firestoreRe2Scenario.rules)).toEqual([]);
  });
});

describe('Firestore: a pattern from request data past the size limit (#1264)', () => {
  function create(condition: string, expectation: 'ALLOW' | 'DENY'): { source: string; cases: TestCase[] } {
    return {
      source: firestoreSource(condition),
      cases: [{
        description: condition,
        expectation,
        method: 'create',
        path: 'p/d1',
        data: { p: NESTED },
      } as TestCase],
    };
  }

  const absorbed = create("'a'.matches(request.resource.data.p) || true", 'ALLOW');
  const alone = create("'a'.matches(request.resource.data.p)", 'DENY');

  for (const { source, cases } of [absorbed, alone]) {
    const expected = cases[0]!.expectation;
    test(`simulate(): ${cases[0]!.description} is ${expected}`, () => {
      const summary = bounded(() => firestoreRules(source).simulate(cases));
      expect(summary.cases.map((c) => c.decision)).toEqual([expected]);
    });

    test(`the in-page sandbox: ${cases[0]!.description} is ${expected}`, () => {
      const result = bounded(() =>
        simulateDeployedRules(new RulesState(source), new SimulateFirestoreRulesHandler(), cases, {}));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.results.map((r) => r.decision)).toEqual([expected]);
    });
  }

  test('split() and replace() refuse it too', () => {
    const split = create("'a'.split(request.resource.data.p).size() == 1 || true", 'ALLOW');
    const replace = create("'a'.replace(request.resource.data.p, 'b') == 'a'", 'DENY');
    for (const { source, cases } of [split, replace]) {
      const summary = bounded(() => firestoreRules(source).simulate(cases));
      expect(summary.cases.map((c) => c.decision)).toEqual([cases[0]!.expectation]);
    }
  });
});

describe('Storage: regex literals past the size limit (#1264)', () => {
  test('compileStorageRules() refuses the nested repeat with the limit message', () => {
    const message = bounded(() => storageCompileMessage(storageSource(`'a'.matches('${NESTED}')`)));
    expect(message).toBe(`Storage rules do not compile: ${invalid(NESTED)} ${LIMIT_SENTENCE}`);
  });

  test('a{1001} is refused at compile (ST-H3-10)', () => {
    const message = bounded(() => storageCompileMessage(storageSource(`'a'.matches('${OVER_REPEAT_CAP}')`)));
    expect(message).toBe(`Storage rules do not compile: ${invalid(OVER_REPEAT_CAP)}`);
  });

  for (const pattern of CONTROLS) {
    test(`${pattern} still compiles`, () => {
      expect(bounded(() => storageCompileMessage(storageSource(`'a'.matches('${pattern}')`)))).toBeNull();
    });
  }

  test('every pattern in the RE2 classes scenario still compiles', () => {
    expect(storageCompileMessage(storageRe2Scenario.rules)).toBeNull();
  });
});

describe('Storage: a pattern from request data past the size limit (#1264)', () => {
  function allowed(condition: string): boolean {
    const { rules } = compileStorageRules(storageSource(condition));
    return evaluateStorageRules(rules, {
      request: { auth: null, method: 'get', path: '/b/bucket/o/file.txt' },
      resource: { size: 1, metadata: { p: NESTED } },
    }).allowed;
  }

  test('an error that || true absorbs', () => {
    expect(bounded(() => allowed("'a'.matches(resource.metadata.p) || true"))).toBe(true);
  });

  test('an error that denies on its own', () => {
    expect(bounded(() => allowed("'a'.matches(resource.metadata.p)"))).toBe(false);
  });
});
