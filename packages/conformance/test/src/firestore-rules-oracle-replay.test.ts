import { describe, expect, it } from 'bun:test';
import type { Scenario } from '../../rules-corpus/firestore/index.ts';
import { firestoreOracleReplayProblems } from '../../src/firestore-rules-oracle-replay.ts';
import { firestoreScenarioInputDigest } from '../../src/firestore-rules-input-digest.ts';

const scenario: Scenario = {
  id: 'test', fm: 'test', rationale: 'test', rules: 'service cloud.firestore {}',
  cases: [{ description: 'probe', expectation: 'ALLOW', method: 'get', path: 'x/y' }],
};

describe('Firestore Rules oracle replay gate', () => {
  it('rejects a local verdict regression', () => {
    const problems = firestoreOracleReplayProblems(scenario, {
      name: 'rules-firestore-test', rowIds: ['firestore-rules#1'], behavior: { probe: 'ALLOW' },
      inputDigest: firestoreScenarioInputDigest(scenario),
    }, { probe: 'DENY' }, 'conforms');
    expect(problems).toEqual([expect.stringContaining('production "ALLOW", simulator "DENY"')]);
  });
});
