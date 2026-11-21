import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { probe as authWave4LinkingProbe } from '../../probes/auth-kotlin/auth-kotlin-instance-linking-reauth-and-oauth-credentials.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as rtdbWave4LiveProbe } from '../../probes/rtdb-kotlin/rtdb-kotlin-listeners-transactions-connection-and-ondisconnect.ts';
import { probe as rtdbWave4NavProbe } from '../../probes/rtdb-kotlin/rtdb-kotlin-navigation-push-priorities-and-snapshots.ts';
import { probe as rtdbWave4QueriesProbe } from '../../probes/rtdb-kotlin/rtdb-kotlin-queries-ranges-limits-and-permission-denied.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import {
  buildAndroidRtdbPermissionAndQueryRules,
  runAndroidRobolectricProbe,
  type AndroidOracleProbeConfigPayload,
  type AndroidRtdbSessionOptions,
} from '../../src/android-oracle-runtime.ts';
import { loadObservations, REPO_ROOT } from '../../src/ledger.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_ANDROID_WAVE4_PROBES: readonly string[] = [];

const LINKED_AUTH_WAVE4_PROBES = [
  'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
] as const;

const LINKED_RTDB_WAVE4_PROBES = [
  'rtdb-kotlin-listeners-transactions-connection-and-ondisconnect',
  'rtdb-kotlin-navigation-push-priorities-and-snapshots',
  'rtdb-kotlin-queries-ranges-limits-and-permission-denied',
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

describe('Wave 4 android-sdk-probes auth-kotlin and rtdb-kotlin Robolectric probes', () => {
  test('wires Wave 4 Auth and RTDB descriptors, Kotlin runner dispatch arms, and PR #1 / PR #2 registry cleanliness', async () => {
    const rigRoot = join(REPO_ROOT, 'packages', 'conformance', 'rigs', 'native-android-oracle');
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

    expect(authWave4LinkingProbe.rig).toBe('android-sdk-probes');
    expect(authWave4LinkingProbe.pendingRowLink).toBeUndefined();
    expect(authWave4LinkingProbe.matrixRow).toBe('auth-kotlin#1');
    expect(authWave4LinkingProbe.rowIds).toEqual([
      'auth-kotlin#1',
      'auth-kotlin#2',
      'auth-kotlin#3',
      'auth-kotlin#4',
      'auth-kotlin#19',
      'auth-kotlin#23',
      'auth-kotlin#32',
      'auth-kotlin#37',
      'auth-kotlin#38',
      'auth-kotlin#39',
    ]);
    expect(authWave4LinkingProbe.requires).toEqual(['web-config', 'admin-auth']);

    const rtdbWave4Descriptors = [rtdbWave4NavProbe, rtdbWave4QueriesProbe, rtdbWave4LiveProbe];
    for (const descriptor of rtdbWave4Descriptors) {
      expect(descriptor.rig).toBe('android-sdk-probes');
      expect(descriptor.pendingRowLink).toBeUndefined();
      expect(descriptor.matrixRow.startsWith('rtdb-kotlin#')).toBe(true);
      expect(descriptor.rowIds.length).toBeGreaterThan(0);
      expect(descriptor.requires).toEqual(['web-config', 'dedicated-rtdb', 'admin-auth']);
    }
    expect(rtdbWave4NavProbe.matrixRow).toBe('rtdb-kotlin#ref-push');
    expect(rtdbWave4NavProbe.rowIds.length).toBe(12);
    expect(rtdbWave4QueriesProbe.matrixRow).toBe('rtdb-kotlin#query-order-by-key');
    expect(rtdbWave4QueriesProbe.rowIds.length).toBe(5);
    expect(rtdbWave4LiveProbe.matrixRow).toBe('rtdb-kotlin#tx-run');
    expect(rtdbWave4LiveProbe.rowIds.length).toBe(11);

    const loaded = await loadModularProbes('android-sdk-probes');
    const loadedIds = new Set(loaded.map((entry) => entry.id));
    for (const expectedId of [
      ...STAGED_ANDROID_WAVE4_PROBES,
      ...LINKED_AUTH_WAVE4_PROBES,
      ...LINKED_RTDB_WAVE4_PROBES,
    ]) {
      expect(loadedIds.has(expectedId)).toBe(true);
      expect(runnerKotlin).toContain(`"${expectedId}" ->`);
    }

    expectStagedUntilCaptured(STAGED_ANDROID_WAVE4_PROBES, {
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
    for (const linkedAuthName of LINKED_AUTH_WAVE4_PROBES) {
      const committed = byName.get(linkedAuthName);
      expect(committed).toBeDefined();
      expect(committed?.androidBomVersion).toBe('35.2.0');
      expect(committed?.matrixRow).toBe('auth-kotlin#1');
      expect(committed?.rowIds.length).toBe(10);
    }
    for (const linkedRtdbName of LINKED_RTDB_WAVE4_PROBES) {
      const committed = byName.get(linkedRtdbName);
      expect(committed).toBeDefined();
      expect(committed?.androidBomVersion).toBe('35.2.0');
      expect(committed?.matrixRow.startsWith('rtdb-kotlin#')).toBe(true);
      expect(committed?.rowIds.length).toBeGreaterThan(0);
    }
  });

  test('forwards rtdbRunRules with stripTopLevelGrants=true and cleans up sidecar UIDs across Wave 4 Auth and RTDB probes', async () => {
    const queryRules = buildAndroidRtdbPermissionAndQueryRules();
    expect(queryRules).toEqual({
      rtdb_kotlin: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        scores: { '.indexOn': '.value' },
        players: { '.indexOn': ['score', 'tier'] },
      },
      denied_zone: {
        '.read': false,
        '.write': false,
      },
    });

    let capturedSessionOptions: AndroidRtdbSessionOptions | undefined;
    let observedScratchDir = '';
    const deletedUids: string[] = [];

    const rtdbBehavior = await runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-queries-ranges-limits-and-permission-denied',
      needsDedicatedRtdb: true,
      rtdbRunRules: queryRules,
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
            appId: '1:123456789:android:abcdef',
          };
        },
        async openAdminAuth() {
          return {
            async createCustomToken() {
              return 'minted-wave4-rtdb-jwt';
            },
            async deleteUser(uid) {
              deletedUids.push(uid);
            },
            async dispose() {},
          };
        },
        async deployScopedRtdbSession(_sa, _databaseUrl, _runId, fn, options) {
          capturedSessionOptions = options;
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
              deniedReadCancelledWithPermissionDenied: true,
              orderByValueEqualTo20: ['d', 'e'],
            }),
            'utf8',
          );
        },
      },
    });

    expect(rtdbBehavior).toEqual({
      deniedReadCancelledWithPermissionDenied: true,
      orderByValueEqualTo20: ['d', 'e'],
    });
    expect(capturedSessionOptions).toEqual({
      rules: queryRules,
      stripTopLevelGrants: true,
    });
    expect(deletedUids.length).toBe(1);
    expect(existsSync(observedScratchDir)).toBe(false);

    const authDeletedUids: string[] = [];
    let customTokenCalls = 0;
    const authBehavior = await runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
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
              customTokenCalls += 1;
              return 'unexpected';
            },
            async deleteUser(uid) {
              authDeletedUids.push(uid);
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
          writeFileSync(
            parsed.cleanupUidsPath,
            JSON.stringify(['linked-anon-uid-1', 'collision-seed-uid-2']),
            'utf8',
          );
          writeFileSync(
            parsed.outputPath,
            JSON.stringify({
              linkPreservedUid: true,
              googleCredentialProvider: 'google.com',
            }),
            'utf8',
          );
        },
      },
    });

    expect(customTokenCalls).toBe(0);
    expect(authBehavior).toEqual({
      linkPreservedUid: true,
      googleCredentialProvider: 'google.com',
    });
    expect(authDeletedUids).toEqual(['linked-anon-uid-1', 'collision-seed-uid-2']);
  });

  test('schedules Wave 4 probes on ubuntu-latest via planCaptureRun', async () => {
    const plan = await planCaptureRun({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/c/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
      CAPTURE_RUNNER_OS: 'ubuntu-latest',
      INPUT_RIG: 'android-sdk-probes',
      INPUT_FILTER: 'rtdb-kotlin-listeners-transactions-connection-and-ondisconnect',
    });
    expect(plan.shouldRun).toBe(true);
    expect(plan.needsCaptureWif).toBe(true);
    expect(plan.invocations).toEqual([
      {
        rig: 'android-sdk-probes',
        script: 'packages/conformance/src/android-sdk-probes.ts',
        args: [
          '--write',
          '--probe',
          'rtdb-kotlin-listeners-transactions-connection-and-ondisconnect',
        ],
        wifTier: 'capture-write',
        runnerOs: 'ubuntu-latest',
      },
    ]);
  });
});
