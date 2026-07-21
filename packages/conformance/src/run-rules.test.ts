import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnosticTable, existingLinkage, selectFirestoreScenarios } from './run-rules.ts';
import {
  firestoreObservationMatchesScenario,
  firestoreScenarioInputDigest,
} from './firestore-rules-input-digest.ts';

describe('run-rules Firestore scenario selection', () => {
  it('selects exactly one scenario by id', () => {
    expect(
      selectFirestoreScenarios([
        '--scenario',
        'resource-document-identity',
      ]).map((scenario) => scenario.id),
    ).toEqual(['resource-document-identity']);
  });

  it('rejects a selector with no scenario id', () => {
    expect(() => selectFirestoreScenarios(['--scenario'])).toThrow(
      /requires an id/,
    );
  });

  it('rejects an unknown scenario id', () => {
    expect(() =>
      selectFirestoreScenarios(['--scenario', 'not-a-scenario']),
    ).toThrow(/unknown Firestore scenario/);
  });

  it('rejects duplicate scenario selectors', () => {
    expect(() =>
      selectFirestoreScenarios([
        '--scenario',
        'resource-document-identity',
        '--scenario',
        'required-fields-and-mapdiff',
      ]),
    ).toThrow(/only one --scenario/);
  });
});

describe('run-rules observation recapture', () => {
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

  it('retains production diagnostics for held/error-boundary evidence', () => {
    const diagnostics = diagnosticTable([{
      description: 'held case',
      expectation: 'ALLOW',
      state: 'FAILED',
      decision: 'DENY',
      trace: [],
      notes: ['Function not found error: Name: [difference].'],
      api: { errorPosition: { line: 7, column: 12 } },
    }, {
      description: 'clean case',
      expectation: 'ALLOW',
      state: 'PASSED',
      decision: 'ALLOW',
      trace: [],
      notes: [],
    }]);

    expect(diagnostics).toEqual({
      'held case': {
        notes: ['Function not found error: Name: [difference].'],
        api: { errorPosition: { line: 7, column: 12 } },
      },
    });
  });

  it('preserves adjudication linkage from an existing observation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-capture-'));
    const path = join(dir, 'observation.json');
    try {
      writeFileSync(path, JSON.stringify({ matrixRow: 'legacy display', rowIds: ['firestore-rules#161'] }));
      expect(existingLinkage(path)).toEqual({
        matrixRow: 'legacy display',
        rowIds: ['firestore-rules#161'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts unlinked when an observation does not exist yet', () => {
    expect(existingLinkage(join(tmpdir(), `pyric-missing-observation-${Date.now()}.json`))).toEqual({
      matrixRow: '',
      rowIds: [],
    });
  });
});
