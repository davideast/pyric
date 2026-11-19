import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalEnvironment } from '../../../pyric/src/sandbox/internal/index.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { rig as siblingMergeRig } from '../../rigs/firestore-rules-sibling-merge.ts';
import { injectFirestoreProbeRules } from '../../src/firestore-real-rules.ts';
import { firestoreOracleReplayProblems, type FirestoreRulesObservation } from '../../src/firestore-rules-oracle-replay.ts';
import {
  buildSiblingMergeObservation,
  measureSiblingMergeVerdicts,
  type SiblingMergeRunnerClient,
} from '../../src/run-firestore-sibling-merge.ts';
import type { ProbeData, ProbeWrite } from '../../src/firestore-real-sibling-merge.ts';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { assertValidObservationEnvelope } from '../../../../scripts/ci/oracle-observation-diff.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC_PATH = join(HERE, '..', '..', 'src', 'run-firestore-sibling-merge.ts');
const COMMITTED_OBS_PATH = join(
  HERE,
  '..',
  '..',
  'observations',
  'firestore-rules',
  'rules-firestore-atomic-batch-sibling-merge.json',
);

const BASE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
  }
}
`;

function createLocalEnvRunnerClient(options: {
  runId: string;
  rulesSource?: string;
  denyReadinessAttempts?: number;
}): { client: SiblingMergeRunnerClient; callOrder: string[] } {
  const env = new LocalEnvironment();
  let rulesSource = injectFirestoreProbeRules(BASE_RULES, options.runId);
  if (options.rulesSource !== undefined) {
    rulesSource = options.rulesSource;
  }
  const seededDocs: Record<string, ProbeData> = {};
  env.seed({ rules: rulesSource, documents: seededDocs });

  const auth = { uid: `pyric-sibling-merge-${options.runId}` };
  let remainingReadinessDenials = 0;
  if (options.denyReadinessAttempts !== undefined) {
    remainingReadinessDenials = options.denyReadinessAttempts;
  }
  const callOrder: string[] = [];

  const permissionDenied = (): Error => {
    const err = new Error('Missing or insufficient permissions.');
    (err as Error & { code: string }).code = 'permission-denied';
    return err;
  };

  const client: SiblingMergeRunnerClient = {
    async seedAdminDoc(path: string, data: ProbeData): Promise<void> {
      callOrder.push(`seed:${path}`);
      seededDocs[path] = structuredClone(data);
      env.seed({ rules: rulesSource, documents: seededDocs });
    },
    async writeClientSet(path: string, data: ProbeData): Promise<void> {
      callOrder.push(`set:${path}`);
      if (path.endsWith('/browser/readiness') && remainingReadinessDenials > 0) {
        remainingReadinessDenials -= 1;
        throw permissionDenied();
      }
      const res = env.execute({ method: 'set', path, data, auth });
      if (!res.allowed) {
        throw permissionDenied();
      }
    },
    async commitClientBatch(writes: readonly ProbeWrite[]): Promise<void> {
      const joined = writes.map((w) => `${w.method}:${w.path}`).join('+');
      callOrder.push(`batch:${joined}`);
      const res = env.batch([...writes], auth);
      if (!res.allowed) {
        throw permissionDenied();
      }
    },
  };

  return { client, callOrder };
}

describe('firestore-rules-sibling-merge rig manifest and oracle-capture-plan routing', () => {
  it('claims sole prefix ownership of rules-firestore-atomic-batch-sibling-merge and routes via capture-write WIF', async () => {
    expect(siblingMergeRig.safety.unattendedSafe).toBe(true);
    expect(siblingMergeRig.script).toBe('packages/conformance/src/run-firestore-sibling-merge.ts');

    const manifests = await loadRigManifests();
    const owners = manifests.filter((m) =>
      m.observationPrefixes.includes('rules-firestore-atomic-batch-sibling-merge'),
    );
    expect(owners.map((m) => m.id)).toEqual(['firestore-rules-sibling-merge']);

    const dispatchPlan = await planCaptureRun({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      INPUT_RIG: 'firestore-rules-sibling-merge',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/c/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@digame-mas.iam.gserviceaccount.com',
    });
    expect(dispatchPlan.shouldRun).toBe(true);
    expect(dispatchPlan.needsCaptureWif).toBe(true);
    expect(dispatchPlan.needsParityWif).toBe(false);
    expect(dispatchPlan.invocations).toEqual([
      {
        rig: 'firestore-rules-sibling-merge',
        script: 'packages/conformance/src/run-firestore-sibling-merge.ts',
        args: ['--write'],
        wifTier: 'capture-write',
      },
    ]);

    const runnerSource = readFileSync(RUNNER_SRC_PATH, 'utf8');
    expect(runnerSource).toContain(
      '[firestore-rules-sibling-merge] firestore rules restored and verified',
    );
  });
});

describe('measureSiblingMergeVerdicts', () => {
  it('waits out transient permission-denied readiness checks and measures solo DENY controls before batch mutation', async () => {
    const runId = 'sm_unit_1';
    const { client, callOrder } = createLocalEnvRunnerClient({
      runId,
      denyReadinessAttempts: 2,
    });
    let nowMs = 1_000;

    const verdicts = await measureSiblingMergeVerdicts({
      runId,
      client,
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => nowMs,
      postReadySettleMs: 0,
    });

    expect(verdicts).toEqual({
      rulesGetAfterSoloPrimary: 'DENY',
      rulesGetAfterSiblingMergeSoloPrimary: 'DENY',
      rulesGetAfterSiblingMergeBatch: 'ALLOW',
      rulesGetAfterSiblingMergeFullBatch: 'ALLOW',
    });

    const soloIdx = callOrder.indexOf(
      `set:__pyric_firestore_cdd/${runId}/rules_get_after/sibling_merge_solo`,
    );
    const batchIdx = callOrder.findIndex((entry) => entry.startsWith('batch:'));
    expect(soloIdx).toBeGreaterThan(-1);
    expect(batchIdx).toBeGreaterThan(soloIdx);
  });

  it('fails closed when overly permissive rules allow the solo DENY controls', async () => {
    const runId = 'sm_broad_allow';
    const permissiveRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
`;
    const { client } = createLocalEnvRunnerClient({
      runId,
      rulesSource: permissiveRules,
    });

    await expect(
      measureSiblingMergeVerdicts({
        runId,
        client,
        sleep: async () => undefined,
        postReadySettleMs: 0,
      }),
    ).rejects.toThrow(/rulesGetAfterSoloPrimary control answered "ALLOW", expected DENY/);
  });

  it('propagates non-permission-denied transport errors instead of recording DENY', async () => {
    const runId = 'sm_unavailable';
    const { client } = createLocalEnvRunnerClient({ runId });
    const failingClient: SiblingMergeRunnerClient = {
      ...client,
      async commitClientBatch(): Promise<void> {
        const unavailable = new Error('DEADLINE_EXCEEDED');
        (unavailable as Error & { code: string }).code = 'unavailable';
        throw unavailable;
      },
    };

    await expect(
      measureSiblingMergeVerdicts({
        runId,
        client: failingClient,
        sleep: async () => undefined,
        postReadySettleMs: 0,
      }),
    ).rejects.toThrow('DEADLINE_EXCEEDED');
  });
});

describe('buildSiblingMergeObservation', () => {
  const committed = JSON.parse(readFileSync(COMMITTED_OBS_PATH, 'utf8')) as Record<
    string,
    unknown
  > & {
    diagnostics?: { hostedTestApiLimitation?: unknown };
  };

  const passingVerdicts = {
    rulesGetAfterSoloPrimary: 'DENY' as const,
    rulesGetAfterSiblingMergeSoloPrimary: 'DENY' as const,
    rulesGetAfterSiblingMergeBatch: 'ALLOW' as const,
    rulesGetAfterSiblingMergeFullBatch: 'ALLOW' as const,
  };

  it('preserves hostedTestApiLimitation, records all three productionDatabase verdicts, and passes replay + envelope validation', () => {
    const deployedSource = injectFirestoreProbeRules(BASE_RULES, 'sm_obs_1');
    const built = buildSiblingMergeObservation({
      previousObservation: committed,
      verdicts: passingVerdicts,
      observedAt: '2026-11-19T17:00:00.000Z',
      fbSdkVersion: '12.19.0',
      projectId: 'digame-mas',
      originalRulesetName: 'projects/digame-mas/rulesets/orig-1',
      probeRulesetName: 'projects/digame-mas/rulesets/probe-2',
      restoredOriginalRelease: true,
      deployedRulesSource: deployedSource,
    });

    const serialized = `${JSON.stringify(built, null, 2)}\n`;
    expect(() =>
      assertValidObservationEnvelope(
        'packages/conformance/observations/firestore-rules/rules-firestore-atomic-batch-sibling-merge.json',
        serialized,
      ),
    ).not.toThrow();

    const diagnostics = built.diagnostics as {
      productionDatabase: Record<string, unknown>;
      hostedTestApiLimitation: unknown;
    };
    expect(diagnostics.productionDatabase).toEqual({
      siblingMergeBatch: 'ALLOW',
      siblingMergeSoloPrimary: 'DENY',
      siblingMergeFullBatch: 'ALLOW',
    });
    expect(diagnostics.hostedTestApiLimitation).toEqual(
      committed.diagnostics?.hostedTestApiLimitation,
    );

    const scenario = ALL_RULES_FIRESTORE_SCENARIOS.find(
      (entry) => entry.id === 'atomic-batch-sibling-merge',
    );
    expect(scenario).toBeDefined();
    if (scenario) {
      const caseKey = 'getAfter reflects merged pre-existing fields alongside batch updates ALLOW';
      const replayProblems = firestoreOracleReplayProblems(
        scenario,
        built as unknown as FirestoreRulesObservation,
        { [caseKey]: 'ALLOW' },
        { id: 'firestore-rules#190', status: 'conforms' },
      );
      expect(replayProblems).toEqual([]);
    }
  });

  it('refuses unverified rules restoration or missing hostedTestApiLimitation diagnostics', () => {
    expect(() =>
      buildSiblingMergeObservation({
        previousObservation: committed,
        verdicts: passingVerdicts,
        observedAt: '2026-11-19T17:00:00.000Z',
        fbSdkVersion: '12.19.0',
        projectId: 'digame-mas',
        originalRulesetName: 'projects/digame-mas/rulesets/orig-1',
        probeRulesetName: 'projects/digame-mas/rulesets/probe-2',
        restoredOriginalRelease: false,
        deployedRulesSource: BASE_RULES,
      }),
    ).toThrow('verified rules restoration');

    expect(() =>
      buildSiblingMergeObservation({
        previousObservation: { name: 'rules-firestore-atomic-batch-sibling-merge', diagnostics: {} },
        verdicts: passingVerdicts,
        observedAt: '2026-11-19T17:00:00.000Z',
        fbSdkVersion: '12.19.0',
        projectId: 'digame-mas',
        originalRulesetName: 'projects/digame-mas/rulesets/orig-1',
        probeRulesetName: 'projects/digame-mas/rulesets/probe-2',
        restoredOriginalRelease: true,
        deployedRulesSource: BASE_RULES,
      }),
    ).toThrow('hostedTestApiLimitation');
  });
});
