import { describe, expect, test } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  storageObservationName,
} from '../../rules-corpus/storage/index.ts';
import { scenario as authNonNullReadGuard } from '../../rules-corpus/storage/auth-non-null-read-guard.ts';
import { scenario as pathParamBindingInCondition } from '../../rules-corpus/storage/path-param-binding-in-condition.ts';
import { scenario as requestResourceContentTypeEquality } from '../../rules-corpus/storage/request-resource-content-type-equality.ts';
import { scenario as requestResourceSizeStrictLessThan } from '../../rules-corpus/storage/request-resource-size-strict-less-than.ts';
import { scenario as v2RecursiveWildcardZeroOrMore } from '../../rules-corpus/storage/v2-recursive-wildcard-zero-or-more.ts';
import type { StorageScenarioRecord } from '../../rules-corpus/storage/types.ts';
import { loadObservations } from '../../src/ledger.ts';
import { selectStorageScenarios } from '../../src/run-rules-storage.ts';
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

const LINKED_SCENARIO_RECORDS: ReadonlyArray<{
  id: string;
  matrixRow: string;
  rowIds: readonly string[];
  record: StorageScenarioRecord;
}> = [
  {
    id: 'auth-non-null-read-guard',
    matrixRow: 'storage-rules#98',
    rowIds: ['storage-rules#98', 'storage-rules#99'],
    record: authNonNullReadGuard,
  },
  {
    id: 'request-resource-size-strict-less-than',
    matrixRow: 'storage-rules#100',
    rowIds: ['storage-rules#100'],
    record: requestResourceSizeStrictLessThan,
  },
  {
    id: 'request-resource-content-type-equality',
    matrixRow: 'storage-rules#101',
    rowIds: ['storage-rules#101'],
    record: requestResourceContentTypeEquality,
  },
  {
    id: 'v2-recursive-wildcard-zero-or-more',
    matrixRow: 'storage-rules#102',
    rowIds: ['storage-rules#102'],
    record: v2RecursiveWildcardZeroOrMore,
  },
  {
    id: 'path-param-binding-in-condition',
    matrixRow: 'storage-rules#103',
    rowIds: ['storage-rules#103'],
    record: pathParamBindingInCondition,
  },
];

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
  let existing: EvaluationInput['resource'] = null;
  if (tc.existingResource) {
    let existingSize = 0;
    if (tc.existingResource.size !== undefined) {
      existingSize = tc.existingResource.size;
    }
    existing = {
      size: existingSize,
      contentType: tc.existingResource.contentType,
      metadata: tc.existingResource.metadata,
    };
  }
  return { request, resource: existing };
}

describe('linked rules-storage scenarios for storage-rules#98..103', () => {
  test('links all 5 scenarios to captured storage-rules observations and drops pendingRowLink', () => {
    const byId = new Map(ALL_RULES_STORAGE_SCENARIOS.map((s) => [s.id, s]));
    const obsByName = new Map(loadObservations().map((o) => [o.name, o]));
    const unfilteredWriteIds = new Set(
      selectStorageScenarios(['--write'], ALL_RULES_STORAGE_SCENARIOS).map((s) => s.id),
    );

    for (const { id, matrixRow, rowIds, record } of LINKED_SCENARIO_RECORDS) {
      expect(record.pendingRowLink).toBeUndefined();
      const scenario = byId.get(id);
      expect(scenario).toBeDefined();
      if (!scenario) continue;
      expect(scenario.pendingRowLink).toBeUndefined();
      expect(scenario.rules).toBe(record.rules);
      expect(unfilteredWriteIds.has(id)).toBe(true);

      const selected = selectStorageScenarios(['--write', '--scenario', id]);
      expect(selected.map((s) => s.id)).toEqual([id]);

      const obsName = storageObservationName(scenario);
      const obs = obsByName.get(obsName);
      expect(obs).toBeDefined();
      if (!obs) continue;
      expect(obs.matrixRow).toBe(matrixRow);
      expect(obs.rowIds).toEqual([...rowIds]);
    }
  });

  test('every linked scenario parses, builds valid Rules Test API wire cases, and matches evaluateStorageRules', () => {
    const byId = new Map(ALL_RULES_STORAGE_SCENARIOS.map((s) => [s.id, s]));

    for (const { id } of LINKED_SCENARIO_RECORDS) {
      const scenario = byId.get(id);
      expect(scenario).toBeDefined();
      if (!scenario) continue;

      const parsed = parseStorageRules(scenario.rules);
      for (const tc of scenario.cases) {
        const wire = buildStorageApiTestCase(tc);
        expect(wire.request.path.startsWith('/b/demo-pyric.appspot.com/o/')).toBe(true);
        expect(['get', 'list', 'create', 'update', 'delete']).toContain(wire.request.method);

        const result = evaluateStorageRules(parsed, toEvalInput(tc));
        let actualVerdict = 'DENY';
        if (result.allowed) {
          actualVerdict = 'ALLOW';
        }
        expect(actualVerdict, `${id} :: ${tc.description}`).toBe(tc.expectation);
      }
    }
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
