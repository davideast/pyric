import { createHash } from 'node:crypto';
import { buildApiTestCase } from '../../pyric/src/rules/test/spec.ts';
import type { Scenario, TestCase } from '../rules-corpus/firestore/types.ts';

export interface FirestoreScenarioInputDigest {
  algorithm: 'sha256';
  value: string;
}

/**
 * Bind an observation to the exact production inputs that determine the
 * decision. The description is bound to its exact request because it is the
 * observation-table join key; expectation remains excluded because it is only
 * the Test API's pass/fail oracle, not a production authorization input.
 */
export function firestoreScenarioInputDigest(
  scenario: Pick<Scenario, 'rules' | 'cases'>,
): FirestoreScenarioInputDigest {
  return firestoreRulesTestInputDigest(scenario.rules, scenario.cases);
}

/** Stable identity for any Firestore Rules Test API microprobe. */
export function firestoreRulesTestInputDigest(
  rules: string,
  cases: readonly TestCase[],
): FirestoreScenarioInputDigest {
  const testCases = cases.map((testCase) => {
    const { expectation: _expectation, ...productionInput } = buildApiTestCase(testCase);
    return { description: testCase.description, input: productionInput };
  });
  const payload = {
    source: { files: [{ name: 'firestore.rules', content: rules }] },
    testSuite: { testCases },
  };
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export interface FirestoreObservationIdentity {
  inputDigest?: { algorithm?: unknown; value?: unknown };
  behavior?: Record<string, unknown>;
}

/** True only when the observation covers this exact input and case-key set. */
export function firestoreObservationMatchesScenario(
  scenario: Pick<Scenario, 'rules' | 'cases'>,
  observation: FirestoreObservationIdentity,
): boolean {
  const expected = firestoreScenarioInputDigest(scenario);
  if (
    observation.inputDigest?.algorithm !== expected.algorithm ||
    observation.inputDigest.value !== expected.value
  ) return false;
  const observedCases = Object.keys(observation.behavior ?? {}).sort();
  const scenarioCases = scenario.cases.map(({ description }) => description).sort();
  return JSON.stringify(observedCases) === JSON.stringify(scenarioCases);
}
