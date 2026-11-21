import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  diagnoseCaptureFailure,
  planCaptureRun,
} from '../../../../scripts/ci/oracle-capture-plan.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { probe as firestoreBatchesTxProbe } from '../../probes/firestore-kotlin/firestore-kotlin-batches-transactions-offline-and-errors.ts';
import { probe as firestoreCrudCodecsProbe } from '../../probes/firestore-kotlin/firestore-kotlin-crud-merge-sentinels-and-codecs.ts';
import { probe as firestoreQueriesAggProbe } from '../../probes/firestore-kotlin/firestore-kotlin-queries-cursors-listeners-and-aggregations.ts';
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
  type AndroidOracleProbeConfigPayload,
} from '../../src/android-oracle-runtime.ts';
import { loadObservations, REPO_ROOT } from '../../src/ledger.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';

const LINKED_FIRESTORE_KOTLIN_PROBES = [
  'firestore-kotlin-batches-transactions-offline-and-errors',
  'firestore-kotlin-crud-merge-sentinels-and-codecs',
  'firestore-kotlin-queries-cursors-listeners-and-aggregations',
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

describe('Wave 3 android-sdk-probes firestore-kotlin Robolectric probes', () => {
  test('wires firestore-kotlin surface, Gradle firebase-firestore dependency, Kotlin dispatch arms, and linked descriptors', async () => {
    const firestoreKt = surfaceDescriptors.find((d) => d.surface === 'firestore-kotlin');
    expect(firestoreKt?.captureRigs).toEqual(['android-sdk-probes']);

    const rigRoot = join(REPO_ROOT, 'packages', 'conformance', 'rigs', 'native-android-oracle');
    const gradleBuildSource = readFileSync(join(rigRoot, 'build.gradle.kts'), 'utf8');
    expect(gradleBuildSource).toContain('com.google.firebase:firebase-firestore');

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

    const wave3Descriptors = [
      firestoreCrudCodecsProbe,
      firestoreQueriesAggProbe,
      firestoreBatchesTxProbe,
    ];
    for (const descriptor of wave3Descriptors) {
      expect(descriptor.rig).toBe('android-sdk-probes');
      expect(descriptor.pendingRowLink).toBeUndefined();
      expect(descriptor.matrixRow.startsWith('firestore-kotlin#')).toBe(true);
      expect(descriptor.rowIds.length).toBeGreaterThan(0);
      expect(descriptor.requires).toEqual([
        'web-config',
        'firestore-rules',
        'admin-auth',
        'admin-firestore',
      ]);
    }
    expect(firestoreCrudCodecsProbe.matrixRow).toBe('firestore-kotlin#15');
    expect(firestoreCrudCodecsProbe.rowIds.length).toBe(22);
    expect(firestoreQueriesAggProbe.matrixRow).toBe('firestore-kotlin#21');
    expect(firestoreQueriesAggProbe.rowIds.length).toBe(17);
    expect(firestoreBatchesTxProbe.matrixRow).toBe('firestore-kotlin#48');
    expect(firestoreBatchesTxProbe.rowIds.length).toBe(18);

    const loaded = await loadModularProbes('android-sdk-probes');
    const firestoreLoaded = loaded.filter((entry) => entry.surfaceDir === 'firestore-kotlin');
    expect(firestoreLoaded.map((entry) => entry.id)).toEqual([...LINKED_FIRESTORE_KOTLIN_PROBES]);
    for (const entry of firestoreLoaded) {
      expect(runnerKotlin).toContain(`"${entry.id}" ->`);
    }

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

    const byName = new Map(currentObservations.map((obs) => [obs.name, obs]));
    for (const probeName of LINKED_FIRESTORE_KOTLIN_PROBES) {
      const committed = byName.get(probeName);
      expect(committed).toBeDefined();
      expect(committed?.androidBomVersion).toBe('35.2.0');
      expect(committed?.matrixRow.startsWith('firestore-kotlin#')).toBe(true);
      expect(committed?.rowIds.length).toBeGreaterThan(0);
    }

    const problems = validateCompatibilityRegistry({
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
    expect(problems).toEqual([]);
  });

  test('runAndroidRobolectricProbe deploys scoped Firestore session and cleans up UIDs and scratch state on success and failure', async () => {
    const deletedUids: string[] = [];
    const firestoreSessionEvents: string[] = [];
    let capturedConfig: AndroidOracleProbeConfigPayload | undefined;
    let observedScratchDir = '';

    const behavior = await runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-crud-merge-sentinels-and-codecs',
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
            appId: '1:123456789:web:abcdef',
          };
        },
        async openAdminAuth() {
          return {
            async createCustomToken(uid) {
              expect(uid.startsWith('pyric-android-android_')).toBe(true);
              return 'minted-firestore-custom-jwt';
            },
            async deleteUser(uid) {
              deletedUids.push(uid);
            },
            async dispose() {},
          };
        },
        async deployScopedFirestoreSession(_sa, runId, fn) {
          firestoreSessionEvents.push(`enter:${runId}`);
          try {
            return await fn();
          } finally {
            firestoreSessionEvents.push(`exit:${runId}`);
          }
        },
        executeGradle(req) {
          if (!req.configPath) {
            throw new Error('expected configPath');
          }
          const parsed = JSON.parse(
            readFileSync(req.configPath, 'utf8'),
          ) as AndroidOracleProbeConfigPayload;
          capturedConfig = parsed;
          observedScratchDir = resolve(req.configPath, '..');
          writeFileSync(
            parsed.outputPath,
            JSON.stringify({
              autoDocumentIdLength: 20,
              incrementLongResult: 15,
            }),
            'utf8',
          );
        },
      },
    });

    expect(behavior).toEqual({
      autoDocumentIdLength: 20,
      incrementLongResult: 15,
    });
    expect(capturedConfig?.probeId).toBe('firestore-kotlin-crud-merge-sentinels-and-codecs');
    expect(capturedConfig?.databaseUrl).toBeUndefined();
    expect(capturedConfig?.customToken).toBe('minted-firestore-custom-jwt');
    expect(firestoreSessionEvents.length).toBe(2);
    expect(firestoreSessionEvents[0]?.startsWith('enter:android_')).toBe(true);
    expect(firestoreSessionEvents[1]?.startsWith('exit:android_')).toBe(true);
    expect(deletedUids.length).toBe(1);
    expect(existsSync(observedScratchDir)).toBe(false);

    const failureSessionEvents: string[] = [];
    const failureDeletedUids: string[] = [];
    let failureScratchDir = '';
    await expect(
      runAndroidRobolectricProbe({
        probeId: 'firestore-kotlin-batches-transactions-offline-and-errors',
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
                return 'minted-firestore-custom-jwt';
              },
              async deleteUser(uid) {
                failureDeletedUids.push(uid);
              },
              async dispose() {},
            };
          },
          async deployScopedFirestoreSession(_sa, runId, fn) {
            failureSessionEvents.push(`enter:${runId}`);
            try {
              return await fn();
            } finally {
              failureSessionEvents.push(`exit:${runId}`);
            }
          },
          executeGradle(req) {
            if (!req.configPath) {
              throw new Error('expected configPath');
            }
            failureScratchDir = resolve(req.configPath, '..');
            throw new Error('simulated Firestore DEADLINE_EXCEEDED mid-probe');
          },
        },
      }),
    ).rejects.toThrow(/simulated Firestore DEADLINE_EXCEEDED/);
    expect(failureSessionEvents.length).toBe(2);
    expect(failureSessionEvents[1]?.startsWith('exit:android_')).toBe(true);
    expect(failureDeletedUids.length).toBe(1);
    expect(existsSync(failureScratchDir)).toBe(false);
  });

  test('schedules firestore-kotlin probes via planCaptureRun on ubuntu-latest and surfaces Firestore IAM diagnostics', async () => {
    const plan = await planCaptureRun({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/c/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
      CAPTURE_RUNNER_OS: 'ubuntu-latest',
      INPUT_RIG: 'android-sdk-probes',
      INPUT_FILTER: 'firestore-kotlin-crud-merge-sentinels-and-codecs',
    });
    expect(plan.shouldRun).toBe(true);
    expect(plan.needsCaptureWif).toBe(true);
    expect(plan.invocations).toEqual([
      {
        rig: 'android-sdk-probes',
        script: 'packages/conformance/src/android-sdk-probes.ts',
        args: ['--write', '--probe', 'firestore-kotlin-crud-merge-sentinels-and-codecs'],
        wifTier: 'capture-write',
        runnerOs: 'ubuntu-latest',
      },
    ]);

    const diag = diagnoseCaptureFailure(
      'android-sdk-probes',
      'HTTP 403 PERMISSION_DENIED: Missing or insufficient permissions',
      { CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com' },
    );
    expect(diag).toContain('roles/firebaserules.admin');
    expect(diag).toContain('roles/datastore.user');
  });
});
