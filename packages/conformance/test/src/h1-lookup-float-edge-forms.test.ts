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
import { scenario as authoredScenario } from '../../rules-corpus/storage/h1-lookup-float-edge-forms.ts';
import { ALL_RULES_STORAGE_SCENARIOS, storageObservationName } from '../../rules-corpus/storage/index.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

function buildOfflineLookup(tc: StorageTestCase): FirestoreLookup | undefined {
  if (tc.functionMocks === undefined || tc.functionMocks.length === 0) {
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

const FAIL_CLOSED_CASE_DESCRIPTIONS = [
  'integral float 2.0 as 2.0: $(2.0) mocked at items/2.0',
  'integral float 2.0 as 2: $(2.0) mocked at items/2',
  'integral float(2) as 2.0: $(float(2)) mocked at items/2.0',
  'integral float(2) as 2: $(float(2)) mocked at items/2',
  '2^53 claim scientific: auth claim 9007199254740992 mocked at items/9.007199254740992E15',
  '2^53 field plain: document field 9007199254740992 mocked at items/9007199254740992',
  '2^53 field scientific: document field 9007199254740992 mocked at items/9.007199254740992E15',
  'small claim 0.0005 scientific: auth claim 0.0005 mocked at items/5.0E-4',
  'small claim 0.0005 plain: auth claim 0.0005 mocked at items/0.0005',
  'small field 0.0005 scientific: document field 0.0005 mocked at items/5.0E-4',
  'small field 0.0005 plain: document field 0.0005 mocked at items/0.0005',
  "exponent cast 1e-7: $(float('1e-7')) mocked at Java and JS exponent/plain forms",
  'large claim 10000000.5 scientific: auth claim 10000000.5 mocked at items/1.00000005E7',
  'large claim 10000000.5 plain: auth claim 10000000.5 mocked at items/10000000.5',
  'large field 10000000.5 scientific: document field 10000000.5 mocked at items/1.00000005E7',
  'large field 10000000.5 plain: document field 10000000.5 mocked at items/10000000.5',
  'large claim 1e21: auth claim 1e21 mocked at Java and JS exponent forms',
  'negative zero literal as -0.0: $(-0.0) mocked at items/-0.0',
  'negative zero literal as 0.0 or 0: $(-0.0) mocked at items/0.0 and items/0',
  'negative zero product: $(-1.0 * 0.0) mocked at items/-0.0, items/0.0, and items/0',
  "nan cast: $(float('NaN')) mocked at items/NaN",
  'nan division: $(0.0 / 0.0) mocked at items/NaN',
  "infinity cast: $(float('Infinity')) mocked at items/Infinity",
  "neg infinity cast: $(float('-Infinity')) mocked at items/-Infinity",
  'infinity division: $(1.0 / 0.0) mocked at items/Infinity',
] as const;

describe('h1-lookup-float-edge-forms staged Storage rules-corpus probe (#1815)', () => {
  const scenario = ALL_RULES_STORAGE_SCENARIOS.find(
    (entry) => entry.id === 'h1-lookup-float-edge-forms',
  );

  it('loads from rules-corpus/storage with pendingRowLink enabled and 32 unique cases', () => {
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    expect(scenario).toMatchObject(authoredScenario);
    expect(scenario.pendingRowLink).toBe(true);
    expect(storageObservationName(scenario)).toBe('rules-storage-h1-lookup-float-edge-forms');
    expect(scenario.cases).toHaveLength(32);
    const descriptions = new Set(scenario.cases.map((tc) => tc.description));
    expect(descriptions.size).toBe(32);
  });

  it('compiles cleanly and fails closed offline on unproven integral, scientific, -0, NaN, and infinity float forms', () => {
    if (scenario === undefined) throw new Error('missing scenario h1-lookup-float-edge-forms');
    const parsed = parseStorageRules(scenario.rules);
    const verdicts = new Map<string, 'ALLOW' | 'DENY'>();
    for (const tc of scenario.cases) {
      const result = evaluateStorageRules(parsed, toOfflineInput(tc), undefined, buildOfflineLookup(tc));
      let verdict: 'ALLOW' | 'DENY' = 'DENY';
      if (result.allowed) {
        verdict = 'ALLOW';
      }
      verdicts.set(tc.description, verdict);
    }

    expect(verdicts.get('control: int auth claim 7 in firestore.exists path')).toBe('ALLOW');
    expect(verdicts.get('2^53 claim plain: auth claim 9007199254740992 mocked at items/9007199254740992')).toBe('ALLOW');
    for (const description of FAIL_CLOSED_CASE_DESCRIPTIONS) {
      expect(verdicts.get(description)).toBe('DENY');
    }
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
