import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnoseCaptureFailure, planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { probe as authKotlinSessionProbe } from '../../probes/auth-kotlin/auth-kotlin-anonymous-and-custom-token-session.ts';
import { probe as authKotlinEmailProbe } from '../../probes/auth-kotlin/auth-kotlin-email-password-lifecycle.ts';
import { probe as authKotlinErrorsProbe } from '../../probes/auth-kotlin/auth-kotlin-error-codes-and-exceptions.ts';
import { probe as authKotlinProfileProbe } from '../../probes/auth-kotlin/auth-kotlin-profile-reload-and-listeners.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as rtdbKotlinCrudProbe } from '../../probes/rtdb-kotlin/rtdb-kotlin-dedicated-crud-and-query-order.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { rig as androidSdkProbesRig } from '../../rigs/android-sdk-probes.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import {
  ANDROID_SDK_PROBES_RIG_CONFIG,
  runAndroidSdkProbesCli,
} from '../../src/android-sdk-probes.ts';
import {
  formatAndroidGradleFailureDiagnostics,
  runAndroidOracleGradleTest,
  runAndroidRobolectricProbe,
  type AndroidAdminAuthAdapter,
  type AndroidOracleProbeConfigPayload,
} from '../../src/android-oracle-runtime.ts';
import { loadObservations, REPO_ROOT, type Observation } from '../../src/ledger.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { resolvedAndroidBomVersion } from '../../src/package-version.ts';
import {
  executeModularProbes,
  loadModularProbes,
  validateModularProbeRequirements,
} from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_ANDROID_PROBES = [
  'auth-kotlin-email-password-lifecycle',
  'auth-kotlin-error-codes-and-exceptions',
  'auth-kotlin-profile-reload-and-listeners',
  'rtdb-kotlin-dedicated-crud-and-query-order',
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

describe('android-sdk-probes Robolectric oracle rig', () => {
  test('registers android-sdk-probes manifest, surface contracts, linked session probe, and pinned Android BoM version', async () => {
    expect(resolvedAndroidBomVersion()).toBe('35.2.0');

    const manifests = await loadRigManifests();
    const androidRig = manifests.find((m) => m.id === 'android-sdk-probes');
    expect(androidRig).toBeDefined();
    if (!androidRig) {
      throw new Error('missing android-sdk-probes rig manifest');
    }
    expect(androidRig.script).toBe(androidSdkProbesRig.script);
    expect(authKotlinSessionProbe.rig).toBe('android-sdk-probes');
    expect(authKotlinSessionProbe.pendingRowLink).toBeUndefined();
    expect(authKotlinSessionProbe.matrixRow).toBe('auth-kotlin#8');
    expect(authKotlinSessionProbe.rowIds).toEqual([
      'auth-kotlin#8',
      'auth-kotlin#9',
      'auth-kotlin#10',
      'auth-kotlin#20',
      'auth-kotlin#22',
      'auth-kotlin#24',
      'auth-kotlin#26',
      'auth-kotlin#31',
      'auth-kotlin#32',
    ]);
    expect(authKotlinEmailProbe.rig).toBe('android-sdk-probes');
    expect(authKotlinErrorsProbe.rig).toBe('android-sdk-probes');
    expect(authKotlinProfileProbe.rig).toBe('android-sdk-probes');
    expect(rtdbKotlinCrudProbe.rig).toBe('android-sdk-probes');
    expect(androidRig.automation).toBe('credentialed');
    expect(androidRig.network).toBe('firebase-production');
    expect(androidRig.runnerOs).toBe('ubuntu-latest');
    expect(androidRig.probeDeclaredOwnership).toBe(true);
    expect(androidRig.safety.unattendedSafe).toBe(true);
    expect(androidRig.freshness.versionField).toBe('androidBomVersion');

    const rigRoot = join(REPO_ROOT, 'packages', 'conformance', 'rigs', 'native-android-oracle');
    expect(existsSync(join(rigRoot, 'settings.gradle.kts'))).toBe(true);
    expect(existsSync(join(rigRoot, 'gradle.properties'))).toBe(true);
    expect(existsSync(join(rigRoot, 'build.gradle.kts'))).toBe(true);
    expect(existsSync(join(rigRoot, 'src', 'main', 'AndroidManifest.xml'))).toBe(true);
    expect(
      existsSync(
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
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          rigRoot,
          'src',
          'test',
          'java',
          'dev',
          'pyric',
          'conformance',
          'androidoracle',
          'RobolectricTlsSupport.kt',
        ),
      ),
    ).toBe(true);

    const gradleBuildSource = readFileSync(join(rigRoot, 'build.gradle.kts'), 'utf8');
    expect(gradleBuildSource).toContain('layout.buildDirectory.set');
    expect(gradleBuildSource).toContain('TestExceptionFormat.FULL');
    expect(gradleBuildSource).toContain('showStandardStreams = true');
    expect(gradleBuildSource).toContain('com.google.firebase:firebase-auth');
    expect(gradleBuildSource).toContain('com.google.firebase:firebase-database');
    expect(gradleBuildSource).toContain('org.robolectric:robolectric');

    const authKt = surfaceDescriptors.find((d) => d.surface === 'auth-kotlin');
    const rtdbKt = surfaceDescriptors.find((d) => d.surface === 'rtdb-kotlin');
    expect(authKt?.captureRigs).toEqual(['android-sdk-probes']);
    expect(rtdbKt?.captureRigs).toEqual(['android-sdk-probes']);
  });

  test('discovers linked and staged auth-kotlin and rtdb-kotlin probes and keeps registry validation clean across PR #1 and PR #2 states', async () => {
    const loaded = await loadModularProbes('android-sdk-probes');
    expect(loaded.map((item) => `${item.surfaceDir}/${item.id}`)).toEqual([
      'auth-kotlin/auth-kotlin-anonymous-and-custom-token-session',
      'auth-kotlin/auth-kotlin-email-password-lifecycle',
      'auth-kotlin/auth-kotlin-error-codes-and-exceptions',
      'auth-kotlin/auth-kotlin-profile-reload-and-listeners',
      'rtdb-kotlin/rtdb-kotlin-dedicated-crud-and-query-order',
    ]);

    expectStagedUntilCaptured(STAGED_ANDROID_PROBES, {
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
    for (const stagedName of STAGED_ANDROID_PROBES) {
      let surfaceDir = 'auth-kotlin';
      if (stagedName.startsWith('rtdb-kotlin-')) {
        surfaceDir = 'rtdb-kotlin';
      }
      const simulatedObs: Observation = {
        file: `${stagedName}.json`,
        surfaceDir,
        name: stagedName,
        matrixRow: '',
        rowIds: [],
        observedAt: '2026-11-20T00:00:00.000Z',
        androidBomVersion: '35.2.0',
        behavior: { simulatedCapture: true },
        raw: {
          name: stagedName,
          matrixRow: '',
          rowIds: [],
          description: 'Simulated captured Android observation',
          observedAt: '2026-11-20T00:00:00.000Z',
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

  test('prints inert preview without credentials, formats JUnit XML failure stack traces, and writes androidBomVersion envelopes', async () => {
    await runAndroidSdkProbesCli([], {}, false);

    const loaded = await loadModularProbes('android-sdk-probes');
    expect(() => validateModularProbeRequirements(loaded, {})).toThrow(/Missing oracle credential/);
    expect(() =>
      validateModularProbeRequirements(loaded, {
        PYRIC_ORACLE_PROJECT_ID: 'demo-oracle',
        PYRIC_ORACLE_RTDB_URL: 'https://demo-oracle-default-rtdb.firebaseio.com',
      }),
    ).toThrow(/Missing dedicated RTDB endpoint/);

    const scratchOut = createPrivateJobTmpDir('android-env');
    try {
      const resultsDir = join(scratchOut, 'build', 'test-results', 'testDebugUnitTest');
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        join(resultsDir, 'TEST-dev.pyric.conformance.androidoracle.AndroidOracleProbeRunnerTest.xml'),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<testsuite name="AndroidOracleProbeRunnerTest" tests="1" failures="1">',
          '  <testcase name="captureSelectedOracleProbe">',
          '    <failure message="Timed out waiting for Firebase Task">',
          'java.util.concurrent.TimeoutException: Timed out waiting for Firebase Task &apos;rtdb.itemRef.setValue&apos;',
          '\tat dev.pyric.conformance.androidoracle.AndroidOracleTaskAwaiterKt.awaitFirebaseTask(AndroidOracleTaskAwaiter.kt:40)',
          '    </failure>',
          '  </testcase>',
          '</testsuite>',
        ].join('\n'),
        'utf8',
      );
      const formattedFailure = formatAndroidGradleFailureDiagnostics(
        join(scratchOut, 'build'),
        'Task :testDebugUnitTest FAILED',
        'FAILURE: Build failed with an exception.',
      );
      expect(formattedFailure).toContain('[JUnit TEST-dev.pyric.conformance.androidoracle.AndroidOracleProbeRunnerTest.xml]');
      expect(formattedFailure).toContain("Timed out waiting for Firebase Task 'rtdb.itemRef.setValue'");
      expect(formattedFailure).toContain('AndroidOracleTaskAwaiter.kt:40');
      expect(formattedFailure).toContain('[Gradle output tail]');

      await executeModularProbes({
        config: ANDROID_SDK_PROBES_RIG_CONFIG,
        sdkVersion: '35.2.0',
        projectId: 'demo-oracle',
        observationsRoot: scratchOut,
        probes: [
          {
            id: 'auth-kotlin-email-password-lifecycle',
            surfaceDir: 'auth-kotlin',
            probe: {
              description: 'Synthetic Android Auth probe',
              matrixRow: '',
              rowIds: [],
              pendingRowLink: true,
              rig: 'android-sdk-probes',
              async observe() {
                return { createdUidNonBlank: true };
              },
            },
          },
        ],
      });

      const writtenPath = join(
        scratchOut,
        'auth-kotlin',
        'auth-kotlin-email-password-lifecycle.json',
      );
      const parsed = JSON.parse(readFileSync(writtenPath, 'utf8')) as Record<string, unknown>;
      expect(parsed.androidBomVersion).toBe('35.2.0');
      expect(parsed.fbSdkVersion).toBeUndefined();
      expect(parsed.rowIds).toEqual([]);
      expect(parsed.behavior).toEqual({ createdUidNonBlank: true });
    } finally {
      expect(removePrivateJobTmpDir(scratchOut)).toBe(true);
    }
  });

  test('runAndroidRobolectricProbe writes private job config, enforces dedicated RTDB, and cleans up sidecar UIDs on both success and mid-probe failure', async () => {
    const deletedUids: string[] = [];
    let disposed = false;
    let capturedConfig: AndroidOracleProbeConfigPayload | undefined;
    let observedScratchDir = '';
    let deployedRtdbSessionUrl = '';

    const fakeAdminAuth: AndroidAdminAuthAdapter = {
      async createCustomToken(uid, claims) {
        expect(uid.startsWith('pyric-android-android_')).toBe(true);
        expect(claims).toEqual({ role: 'tester', tier: 2 });
        return 'minted-custom-jwt';
      },
      async deleteUser(uid) {
        deletedUids.push(uid);
      },
      async dispose() {
        disposed = true;
      },
    };

    const behavior = await runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-dedicated-crud-and-query-order',
      needsDedicatedRtdb: true,
      deps: {
        env: {
          PYRIC_ORACLE_PROJECT_ID: 'demo-oracle',
          PYRIC_ORACLE_RTDB_URL: 'https://pyric-oracle-rtdb-2.firebaseio.com',
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
          return fakeAdminAuth;
        },
        async deployScopedRtdbSession(_sa, databaseUrl, _runId, fn) {
          deployedRtdbSessionUrl = databaseUrl;
          return fn();
        },
        executeGradle(req) {
          expect(req.testFilter).toBe(
            'dev.pyric.conformance.androidoracle.AndroidOracleProbeRunnerTest.captureSelectedOracleProbe',
          );
          if (!req.configPath) {
            throw new Error('expected configPath');
          }
          const parsed = JSON.parse(
            readFileSync(req.configPath, 'utf8'),
          ) as AndroidOracleProbeConfigPayload;
          capturedConfig = parsed;
          observedScratchDir = resolve(req.configPath, '..');
          writeFileSync(
            parsed.cleanupUidsPath,
            JSON.stringify(['ephemeral-anon-uid-1']),
            'utf8',
          );
          writeFileSync(
            parsed.outputPath,
            JSON.stringify({
              existsAfterWrite: true,
              incrementedCount: 15,
            }),
            'utf8',
          );
        },
      },
    });

    expect(deployedRtdbSessionUrl).toBe('https://pyric-oracle-rtdb-2.firebaseio.com');
    expect(capturedConfig?.probeId).toBe('rtdb-kotlin-dedicated-crud-and-query-order');
    expect(capturedConfig?.databaseUrl).toBe('https://pyric-oracle-rtdb-2.firebaseio.com');
    expect(capturedConfig?.customToken).toBe('minted-custom-jwt');
    expect(behavior).toEqual({
      existsAfterWrite: true,
      incrementedCount: 15,
    });
    expect(deletedUids.length).toBe(2);
    expect(deletedUids).toContain('ephemeral-anon-uid-1');
    expect(disposed).toBe(true);
    expect(existsSync(observedScratchDir)).toBe(false);

    const failureDeletedUids: string[] = [];
    let failureScratchDir = '';
    await expect(
      runAndroidRobolectricProbe({
        probeId: 'auth-kotlin-email-password-lifecycle',
        needsDedicatedRtdb: false,
        needsCustomToken: false,
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
                throw new Error('createCustomToken must not run when needsCustomToken is false');
              },
              async deleteUser(uid) {
                failureDeletedUids.push(uid);
              },
              async dispose() {},
            };
          },
          executeGradle(req) {
            if (!req.configPath) {
              throw new Error('expected configPath');
            }
            const parsed = JSON.parse(
              readFileSync(req.configPath, 'utf8'),
            ) as AndroidOracleProbeConfigPayload;
            expect(parsed.customToken).toBeUndefined();
            failureScratchDir = resolve(req.configPath, '..');
            writeFileSync(
              parsed.cleanupUidsPath,
              JSON.stringify(['leaked-email-uid-mid-failure']),
              'utf8',
            );
            throw new Error('simulated transient getIdToken failure after createUserWithEmailAndPassword');
          },
        },
      }),
    ).rejects.toThrow(/simulated transient getIdToken failure/);
    expect(failureDeletedUids).toEqual(['leaked-email-uid-mid-failure']);
    expect(existsSync(failureScratchDir)).toBe(false);

    await expect(
      runAndroidRobolectricProbe({
        probeId: 'rtdb-kotlin-dedicated-crud-and-query-order',
        needsDedicatedRtdb: true,
        deps: {
          env: {
            PYRIC_ORACLE_PROJECT_ID: 'demo-oracle',
            PYRIC_ORACLE_RTDB_URL: 'https://demo-oracle-default-rtdb.firebaseio.com',
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
        },
      }),
    ).rejects.toThrow(/dedicated RTDB oracle instance/);
  });

  test('routes android-sdk-probes through CAPTURE_WIF_PROVIDER and filters by CAPTURE_RUNNER_OS', async () => {
    const skippedPlan = await planCaptureRun({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GCP_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      PARITY_SA_EMAIL: 'parity-sa@example.iam.gserviceaccount.com',
      INPUT_RIG: 'android-sdk-probes',
      INPUT_FILTER: 'auth-kotlin-email-password-lifecycle',
    });
    expect(skippedPlan.shouldRun).toBe(false);
    expect(skippedPlan.skippedRigs).toEqual(['android-sdk-probes']);

    const configuredEnv = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/c/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
      INPUT_RIG: 'android-sdk-probes',
      INPUT_FILTER: 'auth-kotlin-email-password-lifecycle',
    };
    const ubuntuPlan = await planCaptureRun({
      ...configuredEnv,
      CAPTURE_RUNNER_OS: 'ubuntu-latest',
    });
    expect(ubuntuPlan.shouldRun).toBe(true);
    expect(ubuntuPlan.needsCaptureWif).toBe(true);
    expect(ubuntuPlan.needsParityWif).toBe(false);
    expect(ubuntuPlan.invocations).toEqual([
      {
        rig: 'android-sdk-probes',
        script: 'packages/conformance/src/android-sdk-probes.ts',
        args: ['--write', '--probe', 'auth-kotlin-email-password-lifecycle'],
        wifTier: 'capture-write',
        runnerOs: 'ubuntu-latest',
      },
    ]);

    const macosFilteredPlan = await planCaptureRun({
      ...configuredEnv,
      CAPTURE_RUNNER_OS: 'macos-latest',
    });
    expect(macosFilteredPlan.shouldRun).toBe(false);
    expect(macosFilteredPlan.invocations).toEqual([]);

    const diag = diagnoseCaptureFailure(
      'android-sdk-probes',
      'HTTP 403 PERMISSION_DENIED: The caller does not have permission',
      { CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com' },
    );
    expect(diag).toContain('capture-sa@example.iam.gserviceaccount.com');
    expect(diag).toContain('roles/firebaseauth.admin');
  });

  test.skipIf(process.env.PYRIC_RUN_ANDROID_ORACLE_SMOKE !== '1')(
    'executes live Robolectric localRobolectricSdkSmokeTest (including loopback WSS FirebaseDatabase round-trip) via Gradle without writing into the repo tree',
    () => {
      runAndroidOracleGradleTest({
        testFilter:
          'dev.pyric.conformance.androidoracle.AndroidOracleProbeRunnerTest.localRobolectricSdkSmokeTest',
      });
      const rigRoot = join(REPO_ROOT, 'packages', 'conformance', 'rigs', 'native-android-oracle');
      expect(existsSync(join(rigRoot, 'build'))).toBe(false);
      expect(existsSync(join(rigRoot, '.gradle'))).toBe(false);
      expect(existsSync(join(rigRoot, '.kotlin'))).toBe(false);
      const dirtyKtClient = execFileSync(
        'git',
        ['status', '--porcelain', '--', 'packages/kt-client'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ).trim();
      expect(dirtyKtClient).toBe('');
    },
    180_000,
  );
});
