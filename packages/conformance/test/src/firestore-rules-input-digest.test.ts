import { describe, expect, it } from 'bun:test';
import {
  firestoreObservationMatchesScenario,
  firestoreScenarioInputDigest,
} from '../../src/firestore-rules-input-digest.ts';

describe('Firestore rules input digest', () => {
  it('binds case labels to production inputs while excluding expectations', () => {
    const scenario = {
      rules: 'service cloud.firestore { match /databases/{database}/documents { match /x/{id} { allow get: if true; } } }',
      cases: [{ description: 'label', expectation: 'ALLOW' as const, method: 'get' as const, path: 'x/a' }],
    };
    const original = firestoreScenarioInputDigest(scenario);
    expect(firestoreScenarioInputDigest({
      ...scenario,
      cases: [{ ...scenario.cases[0]!, expectation: 'DENY' }],
    })).toEqual(original);
    expect(firestoreScenarioInputDigest({
      ...scenario,
      cases: [{ ...scenario.cases[0]!, description: 'renamed' }],
    })).not.toEqual(original);
    expect(firestoreScenarioInputDigest({
      ...scenario,
      cases: [{ ...scenario.cases[0]!, path: 'x/b' }],
    })).not.toEqual(original);
    expect(firestoreScenarioInputDigest({
      ...scenario,
      rules: scenario.rules.replace('if true', 'if false'),
    })).not.toEqual(original);

    expect(firestoreObservationMatchesScenario(scenario, {
      inputDigest: original,
      behavior: { label: 'ALLOW' },
    })).toBe(true);
    expect(firestoreObservationMatchesScenario(scenario, {
      inputDigest: { ...original, value: '0'.repeat(64) },
      behavior: { label: 'ALLOW' },
    })).toBe(false);
    expect(firestoreObservationMatchesScenario(scenario, {
      inputDigest: original,
      behavior: { staleLabel: 'ALLOW' },
    })).toBe(false);
  });
});
