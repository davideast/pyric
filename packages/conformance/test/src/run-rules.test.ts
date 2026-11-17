import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureCompileCheckScenario,
  diagnosticTable,
  existingLinkage,
  isRealDatabaseObservation,
  ownedSkipLine,
  partitionByOwner,
  selectFirestoreScenarios,
} from '../../src/run-rules.ts';

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

describe('run-rules leaves real-database observations to run-firestore-real.ts', () => {
  function withObservation(content: unknown, check: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-owner-'));
    const path = join(dir, 'observation.json');
    try {
      writeFileSync(path, JSON.stringify(content));
      check(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('recognizes productionDatabase diagnostics as the real-database rig', () => {
    withObservation({ diagnostics: { productionDatabase: { soloPrimary: 'DENY' } } }, (path) => {
      expect(isRealDatabaseObservation(path)).toBe(true);
    });
  });

  it('recognizes hostedTestApiLimitation diagnostics as the real-database rig', () => {
    withObservation({ diagnostics: { hostedTestApiLimitation: {} } }, (path) => {
      expect(isRealDatabaseObservation(path)).toBe(true);
    });
  });

  it('treats a Test API observation as its own', () => {
    withObservation({ diagnostics: { 'held case': { notes: ['x'] } } }, (path) => {
      expect(isRealDatabaseObservation(path)).toBe(false);
    });
  });

  it('treats a missing observation as its own', () => {
    expect(isRealDatabaseObservation(join(tmpdir(), `pyric-missing-${Date.now()}.json`))).toBe(false);
  });

  it('skips and names the committed getAfter/existsAfter scenario', () => {
    const { capture, owned } = partitionByOwner(selectFirestoreScenarios([]));
    const ownedIds = owned.map((scenario) => scenario.id);
    expect(ownedIds).toContain('get-after-and-exists-after');
    expect(capture.map((scenario) => scenario.id)).not.toContain('get-after-and-exists-after');
    expect(ownedSkipLine(owned[ownedIds.indexOf('get-after-and-exists-after')]!)).toBe(
      'get-after-and-exists-after: owned by run-firestore-real.ts, not captured here',
    );
  });

  it('skips the atomic batch scenario before its real-database capture lands', () => {
    const { capture, owned } = partitionByOwner(
      selectFirestoreScenarios(['--scenario', 'atomic-batch-sibling-merge']),
    );
    expect(capture).toEqual([]);
    expect(owned.map(ownedSkipLine)).toEqual([
      'atomic-batch-sibling-merge: owned by run-firestore-real.ts, not captured here',
    ]);
  });
});

describe('run-rules compile-check corpus capture', () => {
  it('records COMPILE_ERROR and verbatim sourcePosition issues when projects.test rejects a ruleset', async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          issues: [
            {
              severity: 'ERROR',
              description: "Invalid service name: foo.bar.",
              sourcePosition: { line: 2, column: 9 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const out = await captureCompileCheckScenario(
      {
        id: 'service-name-unknown-in-firestore',
        fm: 'Service name validation',
        rationale: 'Checks unknown service name handling on projects.test.',
        allowCompileError: true,
        rules: "rules_version = '2';\nservice foo.bar {\n  match /items/{id} { allow read: if true; }\n}",
        cases: [{ description: 'unknown service read probe', expectation: 'DENY', method: 'get', path: 'items/1' }],
      },
      { projectId: 'digame-mas', resolveToken: async () => 'fake-token' },
      fakeFetch,
    );

    expect(out.behavior).toEqual({
      'unknown service read probe': 'COMPILE_ERROR',
    });
    expect(out.diagnostics).toEqual({
      compileIssues: {
        notes: ["ERROR@2:9 Invalid service name: foo.bar."],
        api: {
          issues: [
            {
              severity: 'ERROR',
              description: 'Invalid service name: foo.bar.',
              line: 2,
              column: 9,
            },
          ],
        },
      },
    });
  });

  it('records case decisions and compiler issues when projects.test compiles a compile-check scenario', async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          issues: [],
          testResults: [{ state: 'FAILURE', debugMessages: ['No match block matched'] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const out = await captureCompileCheckScenario(
      {
        id: 'service-name-storage-in-firestore',
        fm: 'Service name validation',
        rationale: 'Checks storage service name handling on projects.test.',
        allowCompileError: true,
        rules: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o { match /items/{id} { allow read: if true; } }\n}",
        cases: [{ description: 'storage service read probe', expectation: 'ALLOW', method: 'get', path: 'items/1' }],
      },
      { projectId: 'digame-mas', resolveToken: async () => 'fake-token' },
      fakeFetch,
    );

    expect(out.behavior).toEqual({
      'storage service read probe': 'DENY',
    });
    expect(out.diagnostics).toEqual({
      'storage service read probe': {
        notes: ['No match block matched'],
      },
    });
  });
});
