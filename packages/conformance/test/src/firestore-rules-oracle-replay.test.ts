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
    }, { probe: 'DENY' }, { id: 'firestore-rules#1', status: 'conforms' });
    expect(problems).toEqual([expect.stringContaining('production "ALLOW", simulator "DENY"')]);
  });

  it('rejects extra simulator verdict rows', () => {
    const problems = firestoreOracleReplayProblems(scenario, {
      name: 'rules-firestore-test', rowIds: ['firestore-rules#1'], behavior: { probe: 'ALLOW' },
      inputDigest: firestoreScenarioInputDigest(scenario),
    }, { probe: 'ALLOW', ghost: 'DENY' }, { id: 'firestore-rules#1', status: 'conforms' });
    expect(problems).toEqual([expect.stringContaining('simulator case set is not exact')]);
  });

  it('rejects mislabeled simulator verdict rows', () => {
    const problems = firestoreOracleReplayProblems(scenario, {
      name: 'rules-firestore-test', rowIds: ['firestore-rules#1'], behavior: { probe: 'ALLOW' },
      inputDigest: firestoreScenarioInputDigest(scenario),
    }, { mislabeled: 'ALLOW' }, { id: 'firestore-rules#1', status: 'conforms' });
    expect(problems).toEqual([
      expect.stringContaining('simulator case set is not exact'),
      expect.stringContaining('simulator undefined'),
    ]);
  });

  it('rejects a known divergence if its row is relabeled conformant', () => {
    const divergentScenario: Scenario = {
      ...scenario,
      id: 'get-after-and-exists-after',
      cases: [{ ...scenario.cases[0]!, description: 'getAfter target == request.resource.data ALLOW' }],
    };
    const problems = firestoreOracleReplayProblems(divergentScenario, {
      name: 'rules-firestore-get-after-and-exists-after',
      rowIds: ['firestore-rules#164'],
      behavior: { 'getAfter target == request.resource.data ALLOW': 'DENY' },
      inputDigest: firestoreScenarioInputDigest(divergentScenario),
    }, { 'getAfter target == request.resource.data ALLOW': 'ALLOW' }, {
      id: 'firestore-rules#164', status: 'conforms', conformanceDisposition: 'probe-limitation',
    });
    expect(problems).toEqual([expect.stringContaining('must remain diverged-documented')]);
  });

  it('never lets a simulator abstention underwrite score evidence', () => {
    const problems = firestoreOracleReplayProblems(scenario, {
      name: 'rules-firestore-test', rowIds: ['firestore-rules#1'], behavior: { probe: 'DENY' },
      inputDigest: firestoreScenarioInputDigest(scenario),
    }, { probe: 'UNSUPPORTED' }, { id: 'firestore-rules#1', status: 'unsupported' });
    expect(problems).toEqual([expect.stringContaining('simulator abstained')]);
  });
});
