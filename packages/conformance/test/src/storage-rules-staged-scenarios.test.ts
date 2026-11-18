import { describe, expect, test } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  storageObservationName,
  type StorageScenario,
} from '../../rules-corpus/storage/index.ts';
import { scenario as authNonNullReadGuard } from '../../rules-corpus/storage/auth-non-null-read-guard.ts';
import { scenario as pathParamBindingInCondition } from '../../rules-corpus/storage/path-param-binding-in-condition.ts';
import { scenario as requestResourceContentTypeEquality } from '../../rules-corpus/storage/request-resource-content-type-equality.ts';
import { scenario as requestResourceSizeStrictLessThan } from '../../rules-corpus/storage/request-resource-size-strict-less-than.ts';
import { scenario as v2RecursiveWildcardZeroOrMore } from '../../rules-corpus/storage/v2-recursive-wildcard-zero-or-more.ts';
import type { StorageScenarioRecord } from '../../rules-corpus/storage/types.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import { selectStorageScenarios } from '../../src/run-rules-storage.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
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

const STAGED_SCENARIO_RECORDS: ReadonlyArray<{ id: string; record: StorageScenarioRecord }> = [
  { id: 'auth-non-null-read-guard', record: authNonNullReadGuard },
  { id: 'path-param-binding-in-condition', record: pathParamBindingInCondition },
  { id: 'request-resource-content-type-equality', record: requestResourceContentTypeEquality },
  { id: 'request-resource-size-strict-less-than', record: requestResourceSizeStrictLessThan },
  { id: 'v2-recursive-wildcard-zero-or-more', record: v2RecursiveWildcardZeroOrMore },
];

const STAGED_SCENARIO_IDS = STAGED_SCENARIO_RECORDS.map((entry) => entry.id);

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

function buildSyntheticStorageRulesObservation(scenario: StorageScenario): Observation {
  const obsName = storageObservationName(scenario);
  const behavior: Record<string, string> = {};
  for (const tc of scenario.cases) {
    behavior[tc.description] = tc.expectation;
  }
  return {
    file: `${obsName}.json`,
    surfaceDir: 'storage-rules',
    name: obsName,
    matrixRow: '',
    rowIds: [],
    observedAt: '2026-11-17T00:00:00.000Z',
    fbSdkVersion: '12.19.0',
    behavior,
    raw: {
      name: obsName,
      matrixRow: '',
      rowIds: [],
      description: scenario.rationale,
      observedAt: '2026-11-17T00:00:00.000Z',
      fbSdkVersion: '12.19.0',
      behavior,
    },
  };
}

describe('staged rules-storage scenarios for storage-rules#98..103', () => {
  test('registers all 5 scenarios as uncaptured rules-storage targets with --scenario filters', () => {
    const byId = new Map(ALL_RULES_STORAGE_SCENARIOS.map((s) => [s.id, s]));

    const inertSelectedIds = new Set(selectStorageScenarios([]).map((s) => s.id));
    const unfilteredWriteIds = new Set(selectStorageScenarios(['--write']).map((s) => s.id));
    expect(unfilteredWriteIds.has('common-auth-membership')).toBe(true);

    for (const { id, record } of STAGED_SCENARIO_RECORDS) {
      expect(record.pendingRowLink).toBe(true);
      const scenario = byId.get(id);
      expect(scenario).toBeDefined();
      if (!scenario) continue;
      expect(scenario.pendingRowLink).toBe(true);
      expect(scenario.rules).toBe(record.rules);

      expect(inertSelectedIds.has(id)).toBe(true);

      const obsName = storageObservationName(scenario);
      expectStagedUntilCaptured(obsName, {
        rig: 'rules-storage',
        filterFlag: '--scenario',
        filterValueFor: () => id,
        whenUncaptured: () => {
          expect(unfilteredWriteIds.has(id)).toBe(false);
        },
        whenCaptured: () => {
          expect(unfilteredWriteIds.has(id)).toBe(true);
        },
      });

      const selected = selectStorageScenarios(['--write', '--scenario', id]);
      expect(selected.map((s) => s.id)).toEqual([id]);

      const existingCapturedPath = () => import.meta.path;
      const selectedOnceCaptured = selectStorageScenarios(
        ['--write'],
        [scenario],
        existingCapturedPath,
      );
      expect(selectedOnceCaptured.map((s) => s.id)).toEqual([id]);
    }
  });

  test('every staged scenario parses, builds valid Rules Test API wire cases, and matches evaluateStorageRules', () => {
    const byId = new Map(ALL_RULES_STORAGE_SCENARIOS.map((s) => [s.id, s]));

    for (const id of STAGED_SCENARIO_IDS) {
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

  test('validates cleanly both pre-capture and with unlinked post-capture observations', async () => {
    const rigManifests = await loadRigManifests();
    const probeFiles = listProbeFiles();
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);
    const pendingRowLinkObservations = loadPendingRowLinkObservations();

    const preCaptureProblems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
      probeFiles,
      rulesStorageScenarioIds,
      pendingRowLinkObservations,
    });
    expect(preCaptureProblems).toEqual([]);

    const byName = new Map(loadObservations().map((o) => [o.name, o]));
    for (const id of STAGED_SCENARIO_IDS) {
      const scenario = ALL_RULES_STORAGE_SCENARIOS.find((s) => s.id === id);
      if (!scenario) continue;
      const obs = buildSyntheticStorageRulesObservation(scenario);
      byName.set(obs.name, obs);
    }

    const postCaptureProblems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: [...byName.values()],
      observationExceptions,
      rigManifests,
      probeFiles,
      rulesStorageScenarioIds,
      pendingRowLinkObservations,
    });
    expect(postCaptureProblems).toEqual([]);
  });
});
