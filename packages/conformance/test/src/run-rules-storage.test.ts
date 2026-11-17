import { describe, expect, test } from 'bun:test';
import type { StorageScenario } from '../../rules-corpus/storage/index.ts';
import {
  captureStorageCompileCheckScenario,
  diagnosticTable,
  selectStorageScenarios,
} from '../../src/run-rules-storage.ts';

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

  test('captures Storage allowCompileError scenarios across HTTP 200 issues and HTTP 400 INVALID_ARGUMENT', async () => {
    const sampleScenario: StorageScenario = {
      id: 'storage-path-literal-brace-bind',
      fm: 'Path literal brace placeholder with bind()',
      rationale: 'Checks compile vs runtime behavior on storage.rules.',
      allowCompileError: true,
      rules: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o { match /items/{id} { allow get: if (/a/{x}).bind({'x': '1'}) == path('/a/1'); } }\n}",
      cases: [
        {
          description: "(/a/{x}).bind({'x': '1'}) == path('/a/1')",
          expectation: 'ALLOW',
          method: 'get',
          path: 'items/d1',
        },
      ],
    };

    const fake200Issues: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          issues: [
            {
              severity: 'ERROR',
              description: "Unexpected '{'.",
              sourcePosition: { line: 3, column: 49 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const issueResult = await captureStorageCompileCheckScenario(
      sampleScenario,
      { projectId: 'digame-mas', resolveToken: async () => 'fake-token' },
      fake200Issues,
    );
    expect(issueResult.behavior).toEqual({
      "(/a/{x}).bind({'x': '1'}) == path('/a/1')": 'COMPILE_ERROR',
    });
    expect(issueResult.diagnostics.compileIssues?.notes).toEqual(["ERROR@3:49 Unexpected '{'."]);

    const fake400: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 400, message: 'Compilation failed.', status: 'INVALID_ARGUMENT' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const invalidArgResult = await captureStorageCompileCheckScenario(
      sampleScenario,
      { projectId: 'digame-mas', resolveToken: async () => 'fake-token' },
      fake400,
    );
    expect(invalidArgResult.behavior).toEqual({
      "(/a/{x}).bind({'x': '1'}) == path('/a/1')": 'INVALID_ARGUMENT',
    });
  });
});
