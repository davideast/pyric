import { expect, test } from 'bun:test';
import type { TestResult } from 'pyric/rules/internal';
import { captureRulesEvidence, captureQueryEvidence } from '../../src/firestore/sandbox/rules-evidence.js';

function result(): TestResult {
  return {
    description: 'denied', expectation: 'DENY', state: 'PASSED', decision: 'DENY', notes: [],
    trace: Array.from({ length: 40 }, () => ({
      ruleIndex: 0, operations: ['get'], verdict: 'DENY', conditionText: 'x'.repeat(500),
      expressionTrace: Array.from({ length: 150 }, () => ({
        source: 'request.resource.data', kind: 'memberAccess', parent: null, value: { secret: 'omit me' },
      })),
    })),
  };
}

test('one bounded budget covers all rules and omits object values', () => {
  const evidence = captureRulesEvidence(result(), 'original');
  expect(evidence.truncated).toBe(true);
  expect(evidence.rules).toHaveLength(32);
  expect(evidence.rules.flatMap(rule => rule.checks)).toHaveLength(128);
  expect(JSON.stringify(evidence)).not.toContain('omit me');
});

test('query proof truncation is explicit and retains the evaluated version', () => {
  const evidence = captureQueryEvidence({
    kind: 'no-rule', failures: Array.from({ length: 40 }, () => ({
      kind: 'constraints-not-satisfied', reason: 'x'.repeat(600), residual: { missing: [], mismatched: [] },
    })),
  }, 'original');
  expect(evidence.version).toBe('original');
  expect(evidence.truncated).toBe(true);
  expect(evidence.queryProof!.failures).toHaveLength(32);
});

test('rules version capture works without secure-context crypto', async () => {
  const { RulesState } = await import('../../src/firestore/sandbox/rules-state.js');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const state = new RulesState('original');
    const first = state.captureEvidence(result());
    state.set('changed');
    const second = state.captureEvidence(result());
    expect(first.version).not.toBe(second.version);
    expect(second.decision).toBe(first.decision);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
