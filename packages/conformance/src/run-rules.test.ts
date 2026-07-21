import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnosticTable, existingLinkage, selectFirestoreScenarios } from './run-rules.ts';

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
