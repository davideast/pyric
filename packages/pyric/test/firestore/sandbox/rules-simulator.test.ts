import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { simulateRules } from '../../../src/firestore/sandbox/rules-simulator.js';

const testCase = {
  description: 'get notes/n1',
  expectation: 'ALLOW' as const,
  method: 'get' as const,
  path: 'notes/n1',
  auth: null,
};

describe('simulateRules', () => {
  test('evaluates against the injected state and rules', () => {
    const result = simulateRules(
      new LocalState({ 'notes/n1': { value: 1 } }),
      new RulesState(DEFAULT_OPEN_RULES),
      new SimulateFirestoreRulesHandler(),
      [testCase],
      false,
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.results[0]?.state).toBe('PASSED');
  });

  test('returns an allow result without invoking rule policy for admin bypass', () => {
    const result = simulateRules(
      new LocalState(),
      new RulesState('not valid rules'),
      new SimulateFirestoreRulesHandler(),
      [testCase],
      true,
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.results[0]?.state).toBe('PASSED');
  });
});
