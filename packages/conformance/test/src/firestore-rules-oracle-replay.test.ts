import { describe, expect, it } from 'bun:test';
import type { Scenario } from '../../rules-corpus/firestore/index.ts';
import {
  firestoreOracleRegistryProblems,
  firestoreOracleReplayProblems,
} from '../../src/firestore-rules-oracle-replay.ts';
import { firestoreScenarioInputDigest } from '../../src/firestore-rules-input-digest.ts';

const scenario: Scenario = {
  id: 'test', fm: 'test', rationale: 'test', rules: 'service cloud.firestore {}',
  cases: [{ description: 'probe', expectation: 'ALLOW', method: 'get', path: 'x/y' }],
};

describe('Firestore Rules oracle replay gate', () => {
  const linkedObservation = { name: 'rules-firestore-test', rowIds: ['firestore-rules#1'] };
  const linkedRow = { id: 'firestore-rules#1', oracleObservations: ['rules-firestore-test'] };

  it('rejects an unknown observation row before scoring', () => {
    expect(firestoreOracleRegistryProblems(
      [{ ...linkedObservation, rowIds: ['firestore-rules#999'] }], [linkedRow],
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('unknown Firestore Rules registry row firestore-rules#999'),
    ]));
  });

  it('rejects a stale registry backlink before scoring', () => {
    expect(firestoreOracleRegistryProblems(
      [linkedObservation], [{ ...linkedRow, oracleObservations: ['rules-firestore-other'] }],
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('must link back to exactly this observation'),
      expect.stringContaining('linked observation rules-firestore-other is missing'),
    ]));
  });

  it('rejects multiple observations assigned to one row before scoring', () => {
    expect(firestoreOracleRegistryProblems([
      linkedObservation,
      { name: 'rules-firestore-copy', rowIds: ['firestore-rules#1'] },
    ], [linkedRow])).toEqual(expect.arrayContaining([
      expect.stringContaining('expected exactly one assigned observation'),
    ]));
  });

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
      diagnostics: {
        'getAfter target == request.resource.data ALLOW': {
          notes: ['Function not found error: Name: [getAfter]'],
          api: { functionCalls: [{ function: 'getAfter' }] },
        },
      },
      inputDigest: firestoreScenarioInputDigest(divergentScenario),
    }, { 'getAfter target == request.resource.data ALLOW': 'ALLOW' }, {
      id: 'firestore-rules#164', status: 'conforms', conformanceDisposition: 'probe-limitation',
    });
    expect(problems).toEqual([expect.stringContaining('must remain diverged-documented')]);
  });

  it('rejects a probe limitation whose production diagnostic disappears', () => {
    const divergentScenario: Scenario = {
      ...scenario,
      id: 'get-after-and-exists-after',
      cases: [{ ...scenario.cases[0]!, description: 'getAfter target == request.resource.data ALLOW' }],
    };
    const problems = firestoreOracleReplayProblems(divergentScenario, {
      name: 'rules-firestore-get-after-and-exists-after',
      rowIds: ['firestore-rules#164'],
      behavior: { 'getAfter target == request.resource.data ALLOW': 'DENY' },
      diagnostics: {},
      inputDigest: firestoreScenarioInputDigest(divergentScenario),
    }, { 'getAfter target == request.resource.data ALLOW': 'ALLOW' }, {
      id: 'firestore-rules#164', status: 'diverged-documented', conformanceDisposition: 'probe-limitation',
    });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('missing getAfter function-not-found diagnostic'),
      expect.stringContaining('missing getAfter diagnostic function call'),
    ]));
  });

  it('never lets a simulator abstention underwrite score evidence', () => {
    const problems = firestoreOracleReplayProblems(scenario, {
      name: 'rules-firestore-test', rowIds: ['firestore-rules#1'], behavior: { probe: 'DENY' },
      inputDigest: firestoreScenarioInputDigest(scenario),
    }, { probe: 'UNSUPPORTED' }, { id: 'firestore-rules#1', status: 'unsupported' });
    expect(problems).toEqual([expect.stringContaining('simulator abstained')]);
  });
});
