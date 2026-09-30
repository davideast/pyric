/**
 * How the Firestore simulator and the Storage evaluator compare values in
 * collections, order Map keys, and run `join()` and the other List methods.
 *
 * - `==` compares an int and a float by value, but a List or Map equals
 *   another only when each element has the same numeric type, and inside a
 *   List or Map `0.0` differs from `-0.0` and NaN equals nothing.
 * - List membership (`in`, `hasAny()`, `hasAll()`, `hasOnly()`) and
 *   `removeAll()` compare an element's numeric type, where `-0.0` matches
 *   `0.0`.
 * - A Set and `diff()` compare by numeric value at every depth, and NaN
 *   matches NaN.
 * - `keys()` is in ascending Unicode code point order, and `values()` in the
 *   order a Map literal wrote or the request sent.
 * - A Set has only its own methods, a MapDiff has no Map method, and each
 *   Set method and a List receiver's `hasAll()`, `hasAny()` and `hasOnly()`
 *   check their argument count and type.
 * - `join()` requires one string separator and converts each element as
 *   `string()` does, and a List method on another receiver is "Function not
 *   found error".
 *
 * The cases are the ones production evaluated over the Rules Test API in the
 * Firestore scenarios `cross-type-operator-overloads`,
 * `list-methods-concat-removeall-toset`,
 * `set-algebra-difference-union-intersection` and
 * `required-fields-and-mapdiff`, and the Storage scenarios
 * `list-map-literals-and-slice`, `upload-primitives-boundaries` and
 * `stdlib-sets-and-mapdiff`. Each observation's diagnostics carry the error
 * text production reported.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../../../conformance/rules-corpus/firestore/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../../../conformance/rules-corpus/storage/index.ts';
import type { TestCase } from '../../../src/rules/test/spec.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { FirestoreSet } from '../../../src/rules/simulator/firestore-set.js';
import { mapKeys, mapLiteral, mapValues } from '../../../src/rules/simulator/map-keys.js';
import {
  listElementsEqual,
  rulesValuesEqual,
  setElementsEqual,
} from '../../../src/rules/simulator/value-equality.js';
import { RulesFloat } from '../../../src/rules/simulator/wrappers/float.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

const OBSERVATIONS = join(import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations');

interface Observation {
  behavior: Record<string, 'ALLOW' | 'DENY'>;
  diagnostics?: Record<string, { notes?: string[] }>;
}

interface CapturedCase {
  description: string;
  condition: string;
  verdict: 'ALLOW' | 'DENY';
  /** Production's error text without its line and column prefix. */
  message?: string;
  testCase: TestCase;
}

function readObservation(service: 'firestore' | 'storage', id: string): Observation {
  return JSON.parse(readFileSync(join(OBSERVATIONS, `${service}-rules`, `rules-${service}-${id}.json`), 'utf8'));
}

/** The captured cases whose description starts with `prefix`, with the allow condition of each case's match block. */
function capturedCases(
  service: 'firestore' | 'storage',
  id: string,
  prefix: string,
  matchPattern: (path: string) => RegExp,
): CapturedCase[] {
  const scenarios = service === 'firestore' ? ALL_RULES_FIRESTORE_SCENARIOS : ALL_RULES_STORAGE_SCENARIOS;
  const scenario = scenarios.find((s) => s.id === id)!;
  const observation = readObservation(service, id);
  return scenario.cases
    .filter((c) => c.description.startsWith(prefix))
    .map((c) => {
      const match = matchPattern(c.path).exec(scenario.rules);
      if (!match) throw new Error(`no match block for ${c.path}`);
      const note = observation.diagnostics?.[c.description]?.notes?.[0];
      const message = note?.replace(/^Error: \S+ line \[\d+\], column \[\d+\]\. /, '');
      return {
        description: c.description,
        condition: match[1]!,
        verdict: observation.behavior[c.description]!,
        ...(message === undefined ? {} : { message }),
        testCase: c as TestCase,
      };
    });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Firestore cases generated as `match /<group>/<index>/{id} { allow create: if <condition>; }`. */
function firestoreCases(id: string, group: string): CapturedCase[] {
  return capturedCases('firestore', id, `${group}: `, (path) => {
    const folder = path.split('/').slice(0, 2).join('/');
    return new RegExp(`match /${escape(folder)}/\\{id\\} \\{\\s*allow create: if (.*);`);
  });
}

/** Storage cases generated as `match /<folder>/{name} { allow <verb>: if <condition>; }`. */
function storageCases(id: string, prefix: string): CapturedCase[] {
  return capturedCases('storage', id, prefix, (path) => {
    const folder = path.split('/')[0]!;
    return new RegExp(`match /${escape(folder)}/\\{\\w+\\} \\{\\s*allow \\w+: if (.*?);( \\})?\\n`);
  });
}

const handler = new SimulateFirestoreRulesHandler();

function firestore(testCase: TestCase, condition: string) {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} { allow create: if ${condition}; }
  }
}`;
  const result = handler.simulate(source, [{ ...testCase, path: 't/x' }]);
  if (!result.success) throw new Error(result.error.message);
  const outcome = result.data.results[0]!;
  return { verdict: outcome.decision, text: outcome.trace.map((step) => step.message).join(' ') };
}

function storage(testCase: TestCase, condition: string) {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /t/{file} { allow read, write: if ${condition}; }
  }
}`);
  const incoming = (testCase as { resource?: { size: number; metadata?: Record<string, string> } }).resource;
  const result = evaluateStorageRules(rules, {
    request: {
      auth: { uid: 'u' },
      method: testCase.method === 'get' ? 'get' : 'create',
      path: '/b/pyric-default/o/t/x',
      ...(testCase.method === 'get' ? {} : { resource: incoming ?? { size: 1 } }),
    },
    resource: testCase.method === 'get' ? { size: 10, metadata: { owner: 'alice', label: 'old' } } : null,
  });
  return { verdict: result.allowed ? 'ALLOW' : 'DENY', text: result.reasons.join(' ') };
}

const FIRESTORE_GROUPS = [
  ['cross-type-operator-overloads', 'equalityIdentity', 23],
  ['list-methods-concat-removeall-toset', 'listMethod', 76],
  ['set-algebra-difference-union-intersection', 'setIdentity', 27],
  ['set-algebra-difference-union-intersection', 'setMethod', 35],
  ['required-fields-and-mapdiff', 'keyOrder', 41],
] as const;

const STORAGE_GROUPS = [
  ['list-map-literals-and-slice', 'equality: ', 19],
  ['upload-primitives-boundaries', 'keys order: ', 7],
  ['stdlib-sets-and-mapdiff', 'value identity: ', 33],
  ['stdlib-sets-and-mapdiff', 'set method: ', 35],
] as const;

describe('Firestore simulator, cases production evaluated', () => {
  for (const [id, group, count] of FIRESTORE_GROUPS) {
    const cases = firestoreCases(id, group);
    test(`${id} has its ${group} cases`, () => {
      expect(cases.length).toBe(count);
    });
    for (const { description, condition, verdict, message, testCase } of cases) {
      test(`${description}: ${verdict}`, () => {
        const result = firestore(testCase, condition);
        expect(result.verdict).toBe(verdict);
        if (message !== undefined) expect(result.text).toContain(message);
      });
    }
  }
});

describe('Storage evaluator, cases production evaluated', () => {
  for (const [id, prefix, count] of STORAGE_GROUPS) {
    const cases = storageCases(id, prefix);
    test(`${id} has its ${prefix.trim()} cases`, () => {
      expect(cases.length).toBe(count);
    });
    for (const { description, condition, verdict, message, testCase } of cases) {
      test(`${description}: ${verdict}`, () => {
        const result = storage(testCase, condition);
        expect(result.verdict).toBe(verdict);
        if (message !== undefined) expect(result.text).toContain(message);
      });
    }
  }
});

describe('value equality relations', () => {
  const int = (value: number) => value;
  const float = (value: number) => new RulesFloat(value);
  const nan = () => float(Number.NaN);

  test('== compares numbers by value and collections by element type', () => {
    expect(rulesValuesEqual(int(1), float(1))).toBe(true);
    expect(rulesValuesEqual(int(0), float(-0))).toBe(true);
    expect(rulesValuesEqual(nan(), nan())).toBe(false);
    expect(rulesValuesEqual([int(1)], [float(1)])).toBe(false);
    expect(rulesValuesEqual({ a: int(1) }, { a: float(1) })).toBe(false);
    expect(rulesValuesEqual([float(0)], [float(-0)])).toBe(false);
    expect(rulesValuesEqual([float(-0)], [float(-0)])).toBe(true);
    expect(rulesValuesEqual([nan()], [nan()])).toBe(false);
    expect(rulesValuesEqual([float(1.5)], [float(1.5)])).toBe(true);
    // A non-integral bare number is a float, as a document read supplies it.
    expect(rulesValuesEqual([1.5], [float(1.5)])).toBe(true);
  });

  test('List membership compares element type and treats zeros alike', () => {
    expect(listElementsEqual(int(1), float(1))).toBe(false);
    expect(listElementsEqual(float(-0), float(0))).toBe(true);
    expect(listElementsEqual(int(0), float(-0))).toBe(false);
    expect(listElementsEqual(nan(), nan())).toBe(false);
    expect(listElementsEqual([float(0)], [float(-0)])).toBe(false);
    expect(listElementsEqual([int(1)], [float(1)])).toBe(false);
  });

  test('Set and diff() comparison is by numeric value at every depth', () => {
    expect(setElementsEqual(int(1), float(1))).toBe(true);
    expect(setElementsEqual([int(1)], [float(1)])).toBe(true);
    expect(setElementsEqual({ a: [int(1)] }, { a: [float(1)] })).toBe(true);
    expect(setElementsEqual(float(0), float(-0))).toBe(true);
    expect(setElementsEqual(nan(), nan())).toBe(true);
    expect(setElementsEqual([nan()], [nan()])).toBe(true);
    expect(setElementsEqual(int(1), 'a')).toBe(false);
    expect(new FirestoreSet([int(1), float(1), nan(), nan()]).size()).toBe(2);
  });

  test('values() is in the order a literal wrote, or else property order', () => {
    expect(mapValues(mapLiteral([['b', 1], ['1', 2], ['10', 3], ['9', 4]]))).toEqual([1, 2, 3, 4]);
    expect(mapValues(mapLiteral([['a', 1], ['b', 2], ['a', 3]]))).toEqual([3, 2]);
    expect(mapValues({ b: 1, 1: 2 })).toEqual([2, 1]);
    const literal = mapLiteral([['__proto__', { x: 1 }], ['a', 2]]);
    expect(Object.keys(literal)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(literal)).toBe(Object.prototype);
    expect(JSON.stringify(mapLiteral([['b', 1], ['1', 2]]))).toBe('{"1":2,"b":1}');
  });

  test('keys() is in code point order', () => {
    expect(mapKeys({ b: 1, a: 2, 10: 3, 9: 4, B: 5, _: 6 })).toEqual(['10', '9', 'B', '_', 'a', 'b']);
    expect(mapKeys({ '😀': 1, 'ｚ': 2, 'é': 3 })).toEqual(['é', 'ｚ', '😀']);
    expect(mapKeys({ ab: 1, a: 2, '': 3 })).toEqual(['', 'a', 'ab']);
  });
});
