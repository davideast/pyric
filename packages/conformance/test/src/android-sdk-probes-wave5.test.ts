import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { probe as firestoreWave5InequalityCgTxProbe } from '../../probes/firestore-kotlin/firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry.ts';
import { probe as firestoreWave5InstanceFlowsProbe } from '../../probes/firestore-kotlin/firestore-kotlin-instance-flows-inSync-and-toObject.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import {
  runAndroidRobolectricProbe,
  type AndroidFirestoreSessionOptions,
  type AndroidOracleProbeConfigPayload,
} from '../../src/android-oracle-runtime.ts';
import { loadObservations, REPO_ROOT, type Observation } from '../../src/ledger.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import {
  OracleRulesSession,
  firestoreOracleTarget,
  runWithOracleRulesRestored,
} from '../../src/oracle-rules-session.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_ANDROID_WAVE5_PROBES = [
  'firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry',
  'firestore-kotlin-instance-flows-inSync-and-toObject',
] as const;

function fakeServiceAccount(): OracleServiceAccount {
  return {
    kind: 'application-default',
    project_id: 'demo-oracle',
    client_email: 'oracle-sa@example.iam.gserviceaccount.com',
    credential: {
      async getAccessToken() {
        return { access_token: 'synthetic-token', expires_in: 3600 };
      },
    },
  };
}

describe('Wave 5 android-sdk-probes firestore-kotlin Robolectric probes', () => {
  test('wires Wave 5 Firestore descriptors, Kotlin runner dispatch arms, and PR #1 / PR #2 registry cleanliness', async () => {
    const rigRoot = join(REPO_ROOT, 'packages', 'conformance', 'rigs', 'native-android-oracle');
    const gradleBuildSource = readFileSync(join(rigRoot, 'build.gradle.kts'), 'utf8');
    expect(gradleBuildSource).toContain('org.jetbrains.kotlinx:kotlinx-coroutines-core');

    const runnerKotlin = readFileSync(
      join(
        rigRoot,
        'src',
        'test',
        'java',
        'dev',
        'pyric',
        'conformance',
        'androidoracle',
        'AndroidOracleProbeRunnerTest.kt',
      ),
      'utf8',
    );
    expect(runnerKotlin).toContain('verifyLocalRobolectricFirestoreWave5Smoke(context)');

    const wave5Descriptors = [firestoreWave5InstanceFlowsProbe, firestoreWave5InequalityCgTxProbe];
    for (const descriptor of wave5Descriptors) {
      expect(descriptor.rig).toBe('android-sdk-probes');
      expect(descriptor.pendingRowLink).toBe(true);
      expect(descriptor.matrixRow).toBe('');
      expect(descriptor.rowIds).toEqual([]);
      expect(descriptor.requires).toEqual([
        'web-config',
        'firestore-rules',
        'admin-auth',
        'admin-firestore',
      ]);
    }

    const loaded = await loadModularProbes('android-sdk-probes');
    const loadedIds = new Set(loaded.map((entry) => entry.id));
    for (const expectedId of STAGED_ANDROID_WAVE5_PROBES) {
      expect(loadedIds.has(expectedId)).toBe(true);
      expect(runnerKotlin).toContain(`"${expectedId}" ->`);
    }

    expectStagedUntilCaptured(STAGED_ANDROID_WAVE5_PROBES, {
      rig: 'android-sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });

    const rigManifests = await loadRigManifests();
    const pendingRowLinkObservations = loadPendingRowLinkObservations();
    const currentObservations = loadObservations();
    const probeFiles = listProbeFiles();
    const rulesFirestoreScenarioIds = ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id);
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);
    const rulesRtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS,
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS,
    ].map((s) => s.id);

    const pr1Problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: currentObservations,
      observationExceptions,
      rigManifests,
      probeFiles,
      rulesFirestoreScenarioIds,
      rulesStorageScenarioIds,
      rulesRtdbScenarioIds,
      pendingRowLinkObservations,
    });
    expect(pr1Problems).toEqual([]);

    const byName = new Map(currentObservations.map((obs) => [obs.name, obs]));
    for (const stagedName of STAGED_ANDROID_WAVE5_PROBES) {
      const simulatedObs: Observation = {
        file: `${stagedName}.json`,
        surfaceDir: 'firestore-kotlin',
        name: stagedName,
        matrixRow: '',
        rowIds: [],
        observedAt: '2026-11-21T06:30:00.000Z',
        androidBomVersion: '35.2.0',
        behavior: { simulatedCapture: true },
        raw: {
          name: stagedName,
          matrixRow: '',
          rowIds: [],
          description: 'Simulated captured Wave 5 Android Firestore observation',
          observedAt: '2026-11-21T06:30:00.000Z',
          androidBomVersion: '35.2.0',
          projectId: 'demo-oracle',
          behavior: { simulatedCapture: true },
        },
      };
      byName.set(simulatedObs.name, simulatedObs);
    }

    const pr2Problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: [...byName.values()],
      observationExceptions,
      rigManifests,
      probeFiles,
      rulesFirestoreScenarioIds,
      rulesStorageScenarioIds,
      rulesRtdbScenarioIds,
      pendingRowLinkObservations,
    });
    expect(pr2Problems).toEqual([]);
  });

  test('firestoreOracleTarget scopes collectionGroup rules safely and restores baseline ruleset on exit', async () => {
    const defaultTarget = firestoreOracleTarget();
    expect(defaultTarget.marker).toBe('@pyric/oracle');
    expect(defaultTarget.freshRules).toContain('match /pyric_oracle/{run}/{anything=**}');
    expect(defaultTarget.freshRules).not.toContain('match /{path=**}/');

    const cgTarget = firestoreOracleTarget({ collectionGroupId: 'cg_android_run42' });
    expect(cgTarget.marker).toBe('@pyric/oracle/cg:cg_android_run42');
    expect(cgTarget.freshRules).toContain('match /pyric_oracle/{run}/{anything=**}');
    expect(cgTarget.freshRules).toContain('match /{path=**}/cg_android_run42/{docId}');

    expect(() => firestoreOracleTarget({ collectionGroupId: 'cg/bad' })).toThrow(
      /unsafe Firestore collectionGroupId/,
    );
    expect(() => firestoreOracleTarget({ collectionGroupId: 'cg_bad; allow read' })).toThrow(
      /unsafe Firestore collectionGroupId/,
    );

    const baselineRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{doc} {
      allow read: if true;
    }
  }
}
`;
    const rulesets = new Map<string, string>([
      ['projects/demo-oracle/rulesets/rs-baseline', baselineRules],
    ]);
    let activeRulesetName = 'projects/demo-oracle/rulesets/rs-baseline';
    let createdCounter = 0;

    const session = new OracleRulesSession({
      projectId: 'demo-oracle',
      async accessToken() {
        return 'fake-oauth-token';
      },
      async sleep() {},
      async fetch(url, init) {
        let method = 'GET';
        if (init !== undefined && typeof init.method === 'string') {
          method = init.method;
        }
        if (url.endsWith('/releases/cloud.firestore') && method === 'GET') {
          return new Response(
            JSON.stringify({
              name: 'projects/demo-oracle/releases/cloud.firestore',
              rulesetName: activeRulesetName,
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/releases/cloud.firestore') && method === 'PATCH') {
          const parsedBody = JSON.parse(String(init?.body)) as {
            release: { rulesetName: string };
          };
          activeRulesetName = parsedBody.release.rulesetName;
          return new Response(
            JSON.stringify({
              name: 'projects/demo-oracle/releases/cloud.firestore',
              rulesetName: activeRulesetName,
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/rulesets') && method === 'POST') {
          createdCounter += 1;
          const nextName = `projects/demo-oracle/rulesets/rs-created-${String(createdCounter)}`;
          const parsedBody = JSON.parse(String(init?.body)) as {
            source: { files: Array<{ content: string }> };
          };
          const firstFile = parsedBody.source.files[0];
          let content = '';
          if (firstFile !== undefined) {
            content = firstFile.content;
          }
          rulesets.set(nextName, content);
          return new Response(JSON.stringify({ name: nextName }), { status: 200 });
        }
        for (const [rsName, sourceText] of rulesets.entries()) {
          if (url.endsWith(`/${rsName}`) && method === 'GET') {
            return new Response(
              JSON.stringify({
                name: rsName,
                source: { files: [{ name: 'firestore.rules', content: sourceText }] },
              }),
              { status: 200 },
            );
          }
        }
        return new Response('not found', { status: 404 });
      },
    });

    let activeDuringProbe = '';
    await runWithOracleRulesRestored(session, async () => {
      const outcome = await session.deploy(cgTarget);
      expect(outcome).toBe('merged');
      const storedRules = rulesets.get(activeRulesetName);
      if (storedRules !== undefined) {
        activeDuringProbe = storedRules;
      }
    });

    expect(activeDuringProbe).toContain('match /{path=**}/cg_android_run42/{docId}');
    expect(activeDuringProbe).toContain('match /public/{doc}');
    expect(activeRulesetName).toBe('projects/demo-oracle/rulesets/rs-baseline');
    expect(session.restoredFirestoreOrStorage).toBe(true);
  });

  test('forwards needsFirestoreCollectionGroup=true as cg_<runId> and cleans up UIDs and scratch state', async () => {
    let observedSessionOptions: AndroidFirestoreSessionOptions | undefined;
    let observedRunId = '';
    let observedScratchDir = '';
    const deletedUids: string[] = [];

    const cgBehavior = await runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry',
      needsFirestore: true,
      needsFirestoreCollectionGroup: true,
      deps: {
        env: {
          PYRIC_ORACLE_PROJECT_ID: 'demo-oracle',
        },
        async loadServiceAccount() {
          return fakeServiceAccount();
        },
        async resolveWebConfig() {
          return {
            apiKey: 'AIzaSyntheticOracleKey',
            authDomain: 'demo-oracle.firebaseapp.com',
            projectId: 'demo-oracle',
            appId: '1:123456789:android:abcdef',
          };
        },
        async openAdminAuth() {
          return {
            async createCustomToken() {
              return 'minted-wave5-fs-jwt';
            },
            async deleteUser(uid) {
              deletedUids.push(uid);
            },
            async dispose() {},
          };
        },
        async deployScopedFirestoreSession(_sa, runId, fn, options) {
          observedRunId = runId;
          observedSessionOptions = options;
          return fn();
        },
        executeGradle(req) {
          if (!req.configPath) {
            throw new Error('expected configPath');
          }
          const parsed = JSON.parse(
            readFileSync(req.configPath, 'utf8'),
          ) as AndroidOracleProbeConfigPayload;
          observedScratchDir = resolve(req.configPath, '..');
          writeFileSync(
            parsed.outputPath,
            JSON.stringify({
              collectionGroupIdsSorted: ['cg_org_a', 'cg_root', 'cg_team_x'],
              txRetryAttempts: 2,
            }),
            'utf8',
          );
        },
      },
    });

    expect(cgBehavior).toEqual({
      collectionGroupIdsSorted: ['cg_org_a', 'cg_root', 'cg_team_x'],
      txRetryAttempts: 2,
    });
    expect(observedRunId.startsWith('android_')).toBe(true);
    expect(observedSessionOptions).toEqual({
      collectionGroupId: `cg_${observedRunId}`,
    });
    expect(deletedUids.length).toBe(1);
    expect(existsSync(observedScratchDir)).toBe(false);

    let defaultSessionOptions: AndroidFirestoreSessionOptions | undefined = {
      collectionGroupId: 'sentinel',
    };
    await runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-instance-flows-inSync-and-toObject',
      needsFirestore: true,
      deps: {
        env: {
          PYRIC_ORACLE_PROJECT_ID: 'demo-oracle',
        },
        async loadServiceAccount() {
          return fakeServiceAccount();
        },
        async resolveWebConfig() {
          return {
            apiKey: 'AIzaSyntheticOracleKey',
            authDomain: 'demo-oracle.firebaseapp.com',
            projectId: 'demo-oracle',
          };
        },
        async openAdminAuth() {
          return {
            async createCustomToken() {
              return 'minted-wave5-fs-jwt';
            },
            async deleteUser() {},
            async dispose() {},
          };
        },
        async deployScopedFirestoreSession(_sa, _runId, fn, options) {
          defaultSessionOptions = options;
          return fn();
        },
        executeGradle(req) {
          if (!req.configPath) {
            throw new Error('expected configPath');
          }
          const parsed = JSON.parse(
            readFileSync(req.configPath, 'utf8'),
          ) as AndroidOracleProbeConfigPayload;
          writeFileSync(
            parsed.outputPath,
            JSON.stringify({ defaultInstanceSameAsKtx: true }),
            'utf8',
          );
        },
      },
    });
    expect(defaultSessionOptions).toBeUndefined();
  });

  test('schedules Wave 5 Firestore probes on ubuntu-latest via planCaptureRun', async () => {
    for (const probeName of STAGED_ANDROID_WAVE5_PROBES) {
      const plan = await planCaptureRun({
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/c/providers/gh',
        CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
        CAPTURE_RUNNER_OS: 'ubuntu-latest',
        INPUT_RIG: 'android-sdk-probes',
        INPUT_FILTER: probeName,
      });
      expect(plan.shouldRun).toBe(true);
      expect(plan.needsCaptureWif).toBe(true);
      expect(plan.invocations).toEqual([
        {
          rig: 'android-sdk-probes',
          script: 'packages/conformance/src/android-sdk-probes.ts',
          args: ['--write', '--probe', probeName],
          wifTier: 'capture-write',
          runnerOs: 'ubuntu-latest',
        },
      ]);
    }
  });
});
