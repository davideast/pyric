import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../../../conformance/rules-corpus/firestore/index.ts';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

/**
 * Replays the committed Firestore Rules Test API capture
 * `packages/conformance/observations/firestore-rules/rules-firestore-re2-pattern-semantics.json`
 * (2026-10-27, row firestore-rules#199) through the corpus scenario it was
 * captured from, so each rule and each expected verdict is production's own.
 *
 * - FS2-SIM-5a2: RE2's `.` matches every character but `\n`, so it matches `\r`.
 * - FS2-SIM-5b: `\pL` is the one-letter form of `\p{L}`, not the literal `pL`.
 * - FS2-SIM-6: `split()` and `replace()` honor `(?i)`, and `replace()` reads
 *   `\s` as RE2's `[\t\n\f\r ]`, so it leaves NBSP alone.
 */
const SCENARIO = 're2-pattern-semantics';
const OBSERVATION = join(
  import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'firestore-rules',
  `rules-firestore-${SCENARIO}.json`,
);

const FINDINGS: Readonly<Record<string, readonly string[]>> = {
  'FS2-SIM-5a2': ['dot matches carriage return'],
  'FS2-SIM-5b': ['a is \\pL', 'literal pL is not \\pL'],
  'FS2-SIM-6': [
    'split with (?i) splits both cases',
    'replace with (?i) replaces uppercase',
    'replace \\s leaves NBSP',
  ],
};

const production = (JSON.parse(readFileSync(OBSERVATION, 'utf8')) as {
  behavior: Record<string, 'ALLOW' | 'DENY'>;
}).behavior;

function simulatorVerdicts(): Record<string, string> {
  const scenario = ALL_RULES_FIRESTORE_SCENARIOS.find(({ id }) => id === SCENARIO);
  if (!scenario) throw new Error(`corpus scenario ${SCENARIO} is missing`);
  const result = new SimulateFirestoreRulesHandler().simulate(scenario.rules, scenario.cases);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return Object.fromEntries(result.data.results.map(({ description, decision }) => [description, decision]));
}

const simulated = simulatorVerdicts();

for (const [finding, cases] of Object.entries(FINDINGS)) {
  describe(`${finding}: the simulator gives production's verdict`, () => {
    for (const description of cases) {
      test(description, () => {
        expect(production[description]).toBeDefined();
        expect(simulated[description]).toBe(production[description]!);
      });
    }
  });
}

/**
 * Cases beyond the capture, from the RE2 syntax reference
 * (https://github.com/google/re2/wiki/Syntax): `\PL` negates `\pL`, a
 * one-letter class works inside `[...]`, and `.` still does not match `\n`.
 */
function verdictOf(guard: string): string {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow get: if ${guard};
    }
  }
}`;
  const result = new SimulateFirestoreRulesHandler().simulate(rules, [
    { description: guard, expectation: 'ALLOW', method: 'get', path: 'c/1' },
  ]);
  if (!result.success) return `ERROR:${result.error.code}`;
  return result.data.results[0]?.decision ?? 'NONE';
}

describe('RE2 reference cases next to the capture', () => {
  test.each([
    ["'1'.matches('\\\\PL')"],
    ["!'a'.matches('\\\\PL')"],
    ["'a1'.matches('[\\\\pL\\\\pN]+')"],
    ["!'-'.matches('[\\\\pL]')"],
    ["'7'.matches('\\\\pN')"],
    ["!'a\\nb'.matches('a.b')"],
    ["'aXbxc'.split('(?i)X') == ['a', 'b', 'c']"],
    ["'a\\tb'.replace('\\\\s', '_') == 'a_b'"],
  ])('%s', (guard) => {
    expect(verdictOf(guard)).toBe('ALLOW');
  });
});
