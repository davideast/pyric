import { describe, expect, it } from 'bun:test';
import { evaluateStorageRules } from '../../../rules/src/storage/rules-evaluator.ts';
import {
  parseStorageRules,
  type EvaluationInput,
  type FirestoreLookup,
} from '../../../rules/src/storage/rules.ts';
import {
  buildStorageApiTestCase,
  normalizeStoragePath,
  type StorageTestCase,
} from '../../../rules/src/test/spec.ts';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { scenario as authoredScenario } from '../../rules-corpus/storage/h1-lookup-float-interpolation.ts';
import { ALL_RULES_STORAGE_SCENARIOS, storageObservationName } from '../../rules-corpus/storage/index.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

function buildOfflineLookup(tc: StorageTestCase): FirestoreLookup | undefined {
  if (!tc.functionMocks || tc.functionMocks.length === 0) {
    return undefined;
  }
  const gets = new Map<string, Record<string, unknown>>();
  const exists = new Set<string>();
  for (const mock of tc.functionMocks) {
    if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
      gets.set(mock.path, mock.result);
    } else if (mock.function === 'exists' && mock.result === true) {
      exists.add(mock.path);
    }
  }
  return {
    get: (path) => gets.get(path) ?? null,
    exists: (path) => exists.has(path),
  };
}

function toOfflineInput(tc: StorageTestCase): EvaluationInput {
  const request: EvaluationInput['request'] = {
    auth: tc.auth ?? null,
    method: tc.method,
    path: normalizeStoragePath(tc.path, tc.bucket),
  };
  if (tc.resource) {
    request.resource = {
      size: tc.resource.size ?? 0,
      contentType: tc.resource.contentType,
      metadata: tc.resource.metadata,
    };
  }
  return {
    request,
    resource: null,
  };
}

describe('h1-lookup-float-interpolation staged Storage rules-corpus probe (#1815)', () => {
  const scenario = ALL_RULES_STORAGE_SCENARIOS.find(
    (entry) => entry.id === 'h1-lookup-float-interpolation',
  );

  it('loads from rules-corpus/storage with pendingRowLink enabled and a stable observation stem', () => {
    expect(scenario).toBeDefined();
    if (!scenario) return;
    expect(scenario).toMatchObject(authoredScenario);
    expect(scenario.pendingRowLink).toBe(true);
    expect(storageObservationName(scenario)).toBe('rules-storage-h1-lookup-float-interpolation');
    expect(scenario.cases).toHaveLength(8);
  });

  it('evaluates offline against pyric today: DENY on float claims and fields, ALLOW on integer controls', () => {
    if (!scenario) throw new Error('missing scenario h1-lookup-float-interpolation');
    const parsed = parseStorageRules(scenario.rules);
    const verdicts: Record<string, 'ALLOW' | 'DENY'> = {};
    for (const tc of scenario.cases) {
      const result = evaluateStorageRules(parsed, toOfflineInput(tc), undefined, buildOfflineLookup(tc));
      let verdict: 'ALLOW' | 'DENY' = 'DENY';
      if (result.allowed) {
        verdict = 'ALLOW';
      }
      verdicts[tc.description] = verdict;
    }

    expect(verdicts).toEqual({
      'claim get: float auth claim 1.5 in firestore.get path': 'DENY',
      'claim get control: int auth claim 7 in firestore.get path': 'ALLOW',
      'claim exists: float auth claim 1.5 in firestore.exists path': 'DENY',
      'claim exists control: int auth claim 7 in firestore.exists path': 'ALLOW',
      'field get: float document field 1.5 in firestore.get path': 'DENY',
      'field get control: int document field 7 in firestore.get path': 'ALLOW',
      'field exists: float document field 1.5 in firestore.exists path': 'DENY',
      'field exists control: int document field 7 in firestore.exists path': 'ALLOW',
    });
  });

  it('serializes float 1.5 and int 7 wire values and plans main-branch parity-readonly capture', async () => {
    if (!scenario) throw new Error('missing scenario h1-lookup-float-interpolation');
    const wireCases = scenario.cases.map((tc) => buildStorageApiTestCase(tc));
    expect(wireCases[0]?.request.auth?.token).toEqual({ v: 1.5 });
    expect(wireCases[1]?.request.auth?.token).toEqual({ v: 7 });
    expect(wireCases[4]?.functionMocks?.[0]).toEqual({
      function: 'firestore.get',
      args: [{ exactValue: '/databases/(default)/documents/cfg/main' }],
      result: { value: { data: { v: 1.5 } } },
    });
    expect(wireCases[5]?.functionMocks?.[0]).toEqual({
      function: 'firestore.get',
      args: [{ exactValue: '/databases/(default)/documents/cfg/main' }],
      result: { value: { data: { v: 7 } } },
    });

    expectStagedUntilCaptured('rules-storage-h1-lookup-float-interpolation', {
      rig: 'rules-storage',
      filterFlag: '--scenario',
      filterValueFor: () => 'h1-lookup-float-interpolation',
    });

    const plan = await planCaptureRun(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GCP_WIF_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/p/providers/gh',
        PARITY_SA_EMAIL: 'parity-test-sa@digame-mas.iam.gserviceaccount.com',
        CAPTURE_RUNNER_OS: 'ubuntu-latest',
      },
      {
        stagedTargets: [
          {
            rig: 'rules-storage',
            observationName: 'rules-storage-h1-lookup-float-interpolation',
            filterFlag: '--scenario',
            filterValue: 'h1-lookup-float-interpolation',
          },
        ],
        pendingPrefixRigs: [],
      },
    );
    expect(plan.shouldRun).toBe(true);
    expect(plan.needsParityWif).toBe(true);
    expect(plan.needsCaptureWif).toBe(false);
    expect(plan.invocations).toEqual([
      {
        rig: 'rules-storage',
        script: 'packages/conformance/src/run-rules-storage.ts',
        args: ['--write', '--scenario', 'h1-lookup-float-interpolation'],
        wifTier: 'parity-readonly',
      },
    ]);
  });
});
