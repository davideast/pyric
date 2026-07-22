import { describe, expect, it } from 'bun:test';
import { firestoreScenarioRecordProblems } from '../../rules-corpus/firestore/load.ts';

function record(description: string, expectation: 'ALLOW' | 'DENY') {
  return {
    fm: 'test', rationale: 'test', rules: 'service cloud.firestore {}', group: 'stress',
    cases: [{ description, expectation, method: 'get', path: 'x/y' }],
  };
}

describe('Firestore rules corpus validation', () => {
  it('rejects a description that contradicts its authored expectation', () => {
    expect(firestoreScenarioRecordProblems('test.ts', 'test', record('behavior ALLOW', 'DENY')))
      .toEqual([expect.stringContaining("description contradicts expectation 'DENY'")]);
  });

  it('accepts a matching verdict word', () => {
    expect(firestoreScenarioRecordProblems('test.ts', 'test', record('behavior DENY', 'DENY'))).toEqual([]);
  });
});
