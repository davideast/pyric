import { describe, expect, test } from 'bun:test';
import type { StorageScenario } from '../../rules-corpus/storage/index.ts';
import { diagnosticTable, selectStorageScenarios } from '../../src/run-rules-storage.ts';

const scenarios = [
  { id: 'alpha' },
  { id: 'common-auth-membership' },
] as StorageScenario[];

describe('rules-storage capture selection', () => {
  test('one --scenario flag limits the paid capture to that scenario', () => {
    expect(
      selectStorageScenarios(['--scenario', 'common-auth-membership'], scenarios).map((s) => s.id),
    ).toEqual(['common-auth-membership']);
  });

  test('an unknown scenario fails before making requests', () => {
    expect(() => selectStorageScenarios(['--scenario', 'missing'], scenarios)).toThrow(
      "Unknown Storage rules scenario 'missing'",
    );
  });

  test('preserves hosted function-call diagnostics for advanced probes', () => {
    expect(diagnosticTable([{
      description: 'repeat lookup', expectation: 'ALLOW', state: 'PASSED', decision: 'ALLOW',
      trace: [], notes: ['host note'], api: { functionCalls: [{ function: 'firestore.get' }] },
    }])).toEqual({
      'repeat lookup': {
        notes: ['host note'],
        api: { functionCalls: [{ function: 'firestore.get' }] },
      },
    });
  });
});
