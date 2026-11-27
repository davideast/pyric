import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { scenario as authoredScenario } from '../../rules-corpus/storage/h1-lookup-float-edge-forms.ts';
import { ALL_RULES_STORAGE_SCENARIOS, storageObservationName } from '../../rules-corpus/storage/index.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE_FORMS_OBS_PATH = join(
  HERE,
  '..',
  '..',
  'observations',
  'storage-rules',
  'rules-storage-h1-lookup-float-edge-forms.json',
);

function decodeMockJsonValue(val: unknown): unknown {
  if (typeof val === 'number') {
    if (!Object.is(val, -0) && Number.isInteger(val) && val >= -(2 ** 63) && val < 2 ** 63) {
      return BigInt(val);
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(decodeMockJsonValue);
  if (typeof val !== 'object' || val === null) return val;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = decodeMockJsonValue(v);
  }
  return out;
}

function buildOfflineLookup(tc: StorageTestCase): FirestoreLookup | undefined {
  if (tc.functionMocks === undefined || tc.functionMocks.length === 0) {
    return undefined;
  }
  const gets = new Map<string, Record<string, unknown>>();
  const exists = new Set<string>();
  for (const mock of tc.functionMocks) {
    if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
      gets.set(mock.path, decodeMockJsonValue(mock.result) as Record<string, unknown>);
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
  if (tc.resource !== undefined) {
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

describe('h1-lookup-float-edge-forms Storage rules-corpus probe (#1815)', () => {
  const scenario = ALL_RULES_STORAGE_SCENARIOS.find(
    (entry) => entry.id === 'h1-lookup-float-edge-forms',
  );

  it('loads from rules-corpus/storage with 32 unique cases', () => {
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    expect(scenario).toMatchObject(authoredScenario);
    expect(scenario.pendingRowLink).toBe(true);
    expect(storageObservationName(scenario)).toBe('rules-storage-h1-lookup-float-edge-forms');
    expect(scenario.cases).toHaveLength(32);
    const descriptions = new Set(scenario.cases.map((tc) => tc.description));
    expect(descriptions.size).toBe(32);
  });

  it('compiles cleanly and matches all 32 captured production verdicts offline', () => {
    if (scenario === undefined) throw new Error('missing scenario h1-lookup-float-edge-forms');
    const captured = JSON.parse(readFileSync(EDGE_FORMS_OBS_PATH, 'utf8')) as {
      behavior: Record<string, 'ALLOW' | 'DENY'>;
    };
    const parsed = parseStorageRules(scenario.rules);
    const verdicts: Record<string, 'ALLOW' | 'DENY'> = {};
    for (const tc of scenario.cases) {
      const result = evaluateStorageRules(parsed, toOfflineInput(tc), undefined, buildOfflineLookup(tc));
      verdicts[tc.description] = result.allowed ? 'ALLOW' : 'DENY';
    }
    expect(verdicts).toEqual(captured.behavior);
  });

  it('builds Rules Test API wire cases and plans parity-readonly capture on main push', async () => {
    if (scenario === undefined) throw new Error('missing scenario h1-lookup-float-edge-forms');
    const wireCases = scenario.cases.map((tc) => buildStorageApiTestCase(tc));
    expect(wireCases).toHaveLength(32);
    expect(wireCases[0]?.request.auth?.token).toEqual({ v: 7 });
    expect(wireCases[14]?.request.auth?.token).toEqual({ v: 0.0005 });
    expect(wireCases[19]?.request.auth?.token).toEqual({ v: 10000000.5 });

    expectStagedUntilCaptured('rules-storage-h1-lookup-float-edge-forms', {
      rig: 'rules-storage',
      filterFlag: '--scenario',
      filterValueFor: () => 'h1-lookup-float-edge-forms',
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
            observationName: 'rules-storage-h1-lookup-float-edge-forms',
            filterFlag: '--scenario',
            filterValue: 'h1-lookup-float-edge-forms',
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
        args: ['--write', '--scenario', 'h1-lookup-float-edge-forms'],
        wifTier: 'parity-readonly',
      },
    ]);
  });
});
