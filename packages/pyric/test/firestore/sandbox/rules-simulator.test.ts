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

  test('passes the cached AST and the deployed source on every call', () => {
    const rules = new RulesState(DEFAULT_OPEN_RULES);
    const simulator = new SimulateFirestoreRulesHandler();
    const received: { ast: unknown; source: string }[] = [];
    const simulateParsed = simulator.simulateParsed.bind(simulator);
    simulator.simulateParsed = (ast, source, cases, options) => {
      received.push({ ast, source });
      return simulateParsed(ast, source, cases, options);
    };
    simulator.simulate = () => {
      throw new Error('simulate(source) parses the ruleset again');
    };
    const state = new LocalState({ 'notes/n1': { value: 1 } });

    for (let i = 0; i < 3; i++) {
      const result = simulateRules(state, rules, simulator, [testCase], false);
      expect(result.success).toBe(true);
    }

    expect(received).toHaveLength(3);
    for (const call of received) {
      expect(call.ast).toBe(rules.ast()!);
      expect(call.source).toBe(rules.source);
    }
  });
});
