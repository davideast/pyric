import { describe, expect, test } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  RULES_STORAGE_OBSERVATION_PREFIX,
  storageObservationName,
} from '../../rules-corpus/storage/index.ts';
import { scenario as parseCompoundStorageRuleset } from '../../rules-corpus/storage/parse-compound-storage-ruleset.ts';
import { scenario as serviceNameFirestoreInStorage } from '../../rules-corpus/storage/service-name-firestore-in-storage.ts';
import { scenario as serviceNameUnknownInStorage } from '../../rules-corpus/storage/service-name-unknown-in-storage.ts';
import { scenario as unterminatedStringLiteral } from '../../rules-corpus/storage/unterminated-string-literal.ts';
import type { StorageScenarioRecord } from '../../rules-corpus/storage/types.ts';
import { loadObservations } from '../../src/ledger.ts';
import {
  captureStorageCompileCheckScenario,
  selectStorageScenarios,
} from '../../src/run-rules-storage.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import {
  buildStorageApiTestCase,
  normalizeStoragePath,
  type StorageTestCase,
} from '../../../rules/src/test/spec.ts';
import {
  parseStorageRules,
  type EvaluationInput,
} from '../../../rules/src/storage/rules.ts';
import { evaluateStorageRules } from '../../../rules/src/storage/rules-evaluator.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_SCENARIO_RECORDS: ReadonlyArray<{
  id: string;
  allowCompileError: boolean;
  record: StorageScenarioRecord;
}> = [
  {
    id: 'parse-compound-storage-ruleset',
    allowCompileError: false,
    record: parseCompoundStorageRuleset,
  },
  {
    id: 'service-name-firestore-in-storage',
    allowCompileError: true,
    record: serviceNameFirestoreInStorage,
  },
  {
    id: 'service-name-unknown-in-storage',
    allowCompileError: true,
    record: serviceNameUnknownInStorage,
  },
  {
    id: 'unterminated-string-literal',
    allowCompileError: true,
    record: unterminatedStringLiteral,
  },
];

const STAGED_OBSERVATION_NAMES = STAGED_SCENARIO_RECORDS.map(
  ({ id }) => `${RULES_STORAGE_OBSERVATION_PREFIX}${id}`,
);

function toEvalInput(tc: StorageTestCase): EvaluationInput {
  const path = normalizeStoragePath(tc.path, tc.bucket);
  let auth: EvaluationInput['request']['auth'] = null;
  if (tc.auth !== undefined && tc.auth !== null) {
    auth = tc.auth;
  }
  const request: EvaluationInput['request'] = {
    auth,
    method: tc.method,
    path,
  };
  if (tc.resource) {
    let size = 0;
    if (tc.resource.size !== undefined) {
      size = tc.resource.size;
    }
    request.resource = {
      size,
      contentType: tc.resource.contentType,
      metadata: tc.resource.metadata,
    };
  }
  return { request, resource: null };
}

describe('staged rules-storage scenarios for storage-rules#94, #95, #97', () => {
  test('registers all 4 scenarios under rules-storage and tracks staged discovery via expectStagedUntilCaptured', () => {
    const byId = new Map(ALL_RULES_STORAGE_SCENARIOS.map((s) => [s.id, s]));
    const unfilteredWriteIds = new Set(
      selectStorageScenarios(['--write'], ALL_RULES_STORAGE_SCENARIOS).map((s) => s.id),
    );

    for (const { id, allowCompileError, record } of STAGED_SCENARIO_RECORDS) {
      expect(record.pendingRowLink).toBe(true);
      const scenario = byId.get(id);
      expect(scenario).toBeDefined();
      if (!scenario) continue;
      expect(scenario.pendingRowLink).toBe(true);
      expect(Boolean(scenario.allowCompileError)).toBe(allowCompileError);
      expect(storageObservationName(scenario)).toBe(`${RULES_STORAGE_OBSERVATION_PREFIX}${id}`);

      const selected = selectStorageScenarios(['--write', '--scenario', id]);
      expect(selected.map((s) => s.id)).toEqual([id]);
    }

    expectStagedUntilCaptured(STAGED_OBSERVATION_NAMES, {
      rig: 'rules-storage',
      filterFlag: '--scenario',
      filterValueFor: (obsName) => obsName.slice(RULES_STORAGE_OBSERVATION_PREFIX.length),
      whenUncaptured: (obsName) => {
        const scenarioId = obsName.slice(RULES_STORAGE_OBSERVATION_PREFIX.length);
        expect(unfilteredWriteIds.has(scenarioId)).toBe(false);
      },
      whenCaptured: (obsName) => {
        const scenarioId = obsName.slice(RULES_STORAGE_OBSERVATION_PREFIX.length);
        expect(unfilteredWriteIds.has(scenarioId)).toBe(false);
      },
    });
  });

  test('parse-compound-storage-ruleset parses cleanly and matches evaluateStorageRules across all 6 cases', () => {
    const scenario = ALL_RULES_STORAGE_SCENARIOS.find(
      (s) => s.id === 'parse-compound-storage-ruleset',
    );
    expect(scenario).toBeDefined();
    if (!scenario) return;

    const parsed = parseStorageRules(scenario.rules);
    for (const tc of scenario.cases) {
      const wire = buildStorageApiTestCase(tc);
      expect(wire.request.path.startsWith('/b/demo-pyric.appspot.com/o/')).toBe(true);

      const result = evaluateStorageRules(parsed, toEvalInput(tc));
      let actualVerdict = 'DENY';
      if (result.allowed) {
        actualVerdict = 'ALLOW';
      }
      expect(actualVerdict, tc.description).toBe(tc.expectation);
    }
  });

  test('allowCompileError scenarios build valid storage.rules compile-check wire payloads', async () => {
    const byId = new Map(ALL_RULES_STORAGE_SCENARIOS.map((s) => [s.id, s]));
    const firestoreInStorage = byId.get('service-name-firestore-in-storage');
    const unknownInStorage = byId.get('service-name-unknown-in-storage');
    const unterminated = byId.get('unterminated-string-literal');
    expect(firestoreInStorage).toBeDefined();
    expect(unknownInStorage).toBeDefined();
    expect(unterminated).toBeDefined();
    if (!firestoreInStorage || !unknownInStorage || !unterminated) return;

    const capturedBodies: Array<{
      source?: { files?: Array<{ name?: string; content?: string }> };
    }> = [];

    const fakeDenyWithWarning: typeof fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          issues: [
            {
              severity: 'WARNING',
              description: 'Invalid service name: foo.bar.',
              sourcePosition: { line: 2, column: 9 },
            },
          ],
          testResults: [{ state: 'SUCCESS' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const scope = {
      projectId: 'demo-rules-project',
      resolveToken: async () => 'fake-token',
    };

    const firestoreOut = await captureStorageCompileCheckScenario(
      firestoreInStorage,
      scope,
      fakeDenyWithWarning,
    );
    expect(firestoreOut.behavior).toEqual({
      'storage get request against a sole service cloud.firestore ruleset': 'DENY',
    });

    const unknownOut = await captureStorageCompileCheckScenario(
      unknownInStorage,
      scope,
      fakeDenyWithWarning,
    );
    expect(unknownOut.behavior).toEqual({
      'storage get request against an unknown service foo.bar ruleset': 'DENY',
    });

    const fakeCompileError: typeof fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          issues: [
            {
              severity: 'ERROR',
              description: "String literal isn't terminated.",
              sourcePosition: { line: 5, column: 22 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const unterminatedOut = await captureStorageCompileCheckScenario(
      unterminated,
      scope,
      fakeCompileError,
    );
    expect(unterminatedOut.behavior).toEqual({
      'storage get request against ruleset with unterminated string literal': 'COMPILE_ERROR',
    });
    expect(unterminatedOut.diagnostics.compileIssues?.notes).toEqual([
      "ERROR@5:22 String literal isn't terminated.",
    ]);
    expect(capturedBodies.map((b) => b.source?.files?.[0]?.name)).toEqual([
      'storage.rules',
      'storage.rules',
      'storage.rules',
    ]);
  });

  test('validates cleanly against the compatibility registry', async () => {
    const rigManifests = await loadRigManifests();
    const probeFiles = listProbeFiles();
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);

    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
      probeFiles,
      rulesStorageScenarioIds,
    });
    expect(problems).toEqual([]);
  });
});
