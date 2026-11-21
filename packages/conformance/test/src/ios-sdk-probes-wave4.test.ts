import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { probe as authWave4LinkingProbe } from '../../probes/auth-swift/auth-swift-instance-linking-reauth-and-oauth-credentials.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as rtdbWave4LiveProbe } from '../../probes/rtdb-swift/rtdb-swift-listeners-transactions-connection-and-ondisconnect.ts';
import { probe as rtdbWave4NavProbe } from '../../probes/rtdb-swift/rtdb-swift-navigation-push-priorities-and-snapshots.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import {
  buildIosRtdbNavigationAndChildQueryRules,
  runIosOracleProbe,
  type IosAdminAuthAdapter,
  type IosRtdbSessionOptions,
} from '../../src/ios-oracle-runtime.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { mergeOracleRtdbRules } from '../../src/oracle-signal-restore.ts';
import { resolvedIosSdkVersion } from '../../src/package-version.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..', '..');
const NATIVE_IOS_ROOT = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle');
const AUTH_SIM_DIR = join(NATIVE_IOS_ROOT, 'auth-sim');
const RTDB_CLI_DIR = join(NATIVE_IOS_ROOT, 'rtdb-cli');

const STAGED_IOS_WAVE4_PROBES = [
  'auth-swift-instance-linking-reauth-and-oauth-credentials',
  'rtdb-swift-listeners-transactions-connection-and-ondisconnect',
  'rtdb-swift-navigation-push-priorities-and-snapshots',
] as const;

const SYNTHETIC_SERVICE_ACCOUNT: OracleServiceAccount = {
  kind: 'application-default',
  project_id: 'demo-oracle-project',
  client_email: 'capture-sa@demo-oracle-project.iam.gserviceaccount.com',
  credential: {
    getAccessToken: async () => ({ access_token: 'synthetic-token', expires_in: 3600 }),
  },
};

function detectSwiftFrontendForParse(): string | null {
  const localFrontend = join(homedir(), '.local', 'swift', 'usr', 'bin', 'swift-frontend');
  if (existsSync(localFrontend)) {
    return localFrontend;
  }
  const pathFrontend = Bun.which('swift-frontend');
  if (pathFrontend !== null) {
    return pathFrontend;
  }
  const swiftc = Bun.which('swiftc');
  if (swiftc !== null) {
    const siblingFrontend = join(dirname(realpathSync(swiftc)), 'swift-frontend');
    if (existsSync(siblingFrontend)) {
      return siblingFrontend;
    }
    return swiftc;
  }
  return null;
}

describe('Wave 4 ios-sdk-probes auth-swift and rtdb-swift oracle probes', () => {
  it('wires Wave 4 Auth and RTDB descriptors, Swift runner dispatch arms, and PR #1 / PR #2 registry cleanliness', async () => {
    expect(authWave4LinkingProbe.rig).toBe('ios-sdk-probes');
    expect(authWave4LinkingProbe.pendingRowLink).toBe(true);
    expect(authWave4LinkingProbe.matrixRow).toBe('');
    expect(authWave4LinkingProbe.rowIds).toEqual([]);
    expect(authWave4LinkingProbe.requires).toEqual(['web-config', 'admin-auth']);

    const rtdbWave4Descriptors = [rtdbWave4NavProbe, rtdbWave4LiveProbe];
    for (const descriptor of rtdbWave4Descriptors) {
      expect(descriptor.rig).toBe('ios-sdk-probes');
      expect(descriptor.pendingRowLink).toBe(true);
      expect(descriptor.matrixRow).toBe('');
      expect(descriptor.rowIds).toEqual([]);
      expect(descriptor.requires).toEqual(['web-config', 'dedicated-rtdb']);
    }

    const allWave4Descriptors = [authWave4LinkingProbe, ...rtdbWave4Descriptors];
    for (const descriptor of allWave4Descriptors) {
      if (process.platform !== 'darwin') {
        await expect(descriptor.observe()).rejects.toThrow(/requires macOS \(darwin\)/);
      }
    }

    const authRunnerSwift = readFileSync(
      join(AUTH_SIM_DIR, 'Sources', 'PyricIosAuthOracle', 'AuthOracleProbeRunner.swift'),
      'utf8',
    );
    const rtdbMainSwift = readFileSync(
      join(RTDB_CLI_DIR, 'Sources', 'RtdbOracleCLI', 'main.swift'),
      'utf8',
    );

    const loaded = await loadModularProbes('ios-sdk-probes');
    const loadedIds = new Set(loaded.map((entry) => entry.id));
    for (const expectedId of STAGED_IOS_WAVE4_PROBES) {
      expect(loadedIds.has(expectedId)).toBe(true);
      if (expectedId.startsWith('auth-swift-')) {
        expect(authRunnerSwift).toContain(`case "${expectedId}":`);
      } else {
        expect(rtdbMainSwift).toContain(`case "${expectedId}":`);
      }
    }

    expectStagedUntilCaptured(STAGED_IOS_WAVE4_PROBES, {
      rig: 'ios-sdk-probes',
      filterFlag: '--probe',
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

    const iosVersion = resolvedIosSdkVersion();
    const byName = new Map(currentObservations.map((obs) => [obs.name, obs]));
    for (const stagedName of STAGED_IOS_WAVE4_PROBES) {
      let surfaceDir = 'rtdb-swift';
      if (stagedName.startsWith('auth-swift-')) {
        surfaceDir = 'auth-swift';
      }
      const simulatedObs: Observation = {
        file: `${stagedName}.json`,
        surfaceDir,
        name: stagedName,
        matrixRow: '',
        rowIds: [],
        observedAt: '2026-11-21T04:30:00.000Z',
        iosSdkVersion: iosVersion,
        behavior: { simulatedCapture: true },
        raw: {
          name: stagedName,
          matrixRow: '',
          rowIds: [],
          description: 'Simulated captured Wave 4 iOS observation',
          observedAt: '2026-11-21T04:30:00.000Z',
          iosSdkVersion: iosVersion,
          projectId: 'demo-oracle-project',
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

  it(
    'verifies Wave 4 Swift API coverage, zero email-sending calls, immediate UID flush, and Swift syntax parsing',
    () => {
      const authWave4Swift = readFileSync(
        join(AUTH_SIM_DIR, 'Sources', 'PyricIosAuthOracle', 'AuthWave4LinkingAndOAuthProbes.swift'),
        'utf8',
      );
      const authWave2Swift = readFileSync(
        join(
          AUTH_SIM_DIR,
          'Sources',
          'PyricIosAuthOracle',
          'AuthEmailPasswordAndProfileProbes.swift',
        ),
        'utf8',
      );
      const authRunnerSwift = readFileSync(
        join(AUTH_SIM_DIR, 'Sources', 'PyricIosAuthOracle', 'AuthOracleProbeRunner.swift'),
        'utf8',
      );

      for (const swiftSrc of [authRunnerSwift, authWave2Swift, authWave4Swift]) {
        expect(swiftSrc).not.toContain('sendPasswordReset');
        expect(swiftSrc).not.toContain('sendEmailVerification');
        expect(swiftSrc).not.toContain('sendSignInLink');
      }

      expect(authWave4Swift).toContain('anonUser.link(with:');
      expect(authWave4Swift).toContain('collisionAnonUser.link(');
      expect(authWave4Swift).toContain('AuthErrorCode.providerAlreadyLinked.rawValue');
      expect(authWave4Swift).toContain('activeUser.reauthenticate(');
      expect(authWave4Swift).toContain('activeUser.updatePassword(to:');
      expect(authWave4Swift).toContain('updatedUser.unlink(fromProvider: EmailAuthProvider.id)');
      expect(authWave4Swift).toContain('GoogleAuthProvider.credential(');
      expect(authWave4Swift).toContain('OAuthProvider.credential(');
      expect(authWave4Swift).not.toContain('withProviderID:');
      expect(authWave4Swift).toContain('addStateDidChangeListener');
      expect(authWave4Swift).toContain('removeStateDidChangeListener');
      expect(authWave4Swift).toContain('addIDTokenDidChangeListener');
      expect(authWave4Swift).toContain('removeIDTokenDidChangeListener');
      expect(authWave4Swift.split('emitCleanupUid(').length - 1).toBeGreaterThanOrEqual(6);

      const rtdbNavSwift = readFileSync(
        join(
          RTDB_CLI_DIR,
          'Sources',
          'RtdbOracleCLI',
          'RtdbWave4NavigationAndSnapshotProbes.swift',
        ),
        'utf8',
      );
      const rtdbLiveSwift = readFileSync(
        join(
          RTDB_CLI_DIR,
          'Sources',
          'RtdbOracleCLI',
          'RtdbWave4ListenersAndOnDisconnectProbes.swift',
        ),
        'utf8',
      );

      expect(rtdbNavSwift).toContain('Database.database()');
      expect(rtdbNavSwift).toContain('Database.database(url:');
      expect(rtdbNavSwift).toContain('setPriorityAsync(');
      expect(rtdbNavSwift).toContain('setValueWithPriorityAsync(');
      expect(rtdbNavSwift).toContain('valueInExportFormat()');
      expect(rtdbNavSwift).toContain('queryOrderedByPriority()');
      expect(rtdbNavSwift).toContain('queryEqual(toValue: "gold", childKey: "p3")');
      expect(rtdbNavSwift).toContain('queryStarting(afterValue: 10)');
      expect(rtdbNavSwift).toContain('queryEnding(beforeValue: 40)');

      expect(rtdbLiveSwift).toContain('.info/connected');
      expect(rtdbLiveSwift).toContain('.info/serverTimeOffset');
      expect(rtdbLiveSwift).toContain('observe(.childAdded)');
      expect(rtdbLiveSwift).toContain('observe(.childChanged)');
      expect(rtdbLiveSwift).toContain('observe(.childMoved)');
      expect(rtdbLiveSwift).toContain('observe(.childRemoved)');
      expect(rtdbLiveSwift).toContain('removeObserver(withHandle:');
      expect(rtdbLiveSwift).toContain('onDisconnectSetValue(');
      expect(rtdbLiveSwift).toContain('onDisconnectUpdateChildValues(');
      expect(rtdbLiveSwift).toContain('onDisconnectRemoveValue');
      expect(rtdbLiveSwift).toContain('cancelDisconnectOperations');

      const swiftParser = detectSwiftFrontendForParse();
      if (swiftParser !== null) {
        const authSwiftFiles = [
          join(AUTH_SIM_DIR, 'Package.swift'),
          join(AUTH_SIM_DIR, 'Sources', 'PyricIosAuthOracle', 'AuthOracleProbeRunner.swift'),
          join(
            AUTH_SIM_DIR,
            'Sources',
            'PyricIosAuthOracle',
            'AuthEmailPasswordAndProfileProbes.swift',
          ),
          join(
            AUTH_SIM_DIR,
            'Sources',
            'PyricIosAuthOracle',
            'AuthWave4LinkingAndOAuthProbes.swift',
          ),
          join(AUTH_SIM_DIR, 'Tests', 'AuthOracleSimTests', 'AuthOracleSimTests.swift'),
        ];
        const authParseRes = spawnSync(swiftParser, ['-parse', ...authSwiftFiles], {
          encoding: 'utf8',
        });
        expect(authParseRes.status, `${authParseRes.stdout}\n${authParseRes.stderr}`).toBe(0);

        const rtdbSwiftFiles = [
          join(RTDB_CLI_DIR, 'Package.swift'),
          join(RTDB_CLI_DIR, 'Sources', 'RtdbOracleCLI', 'main.swift'),
          join(RTDB_CLI_DIR, 'Sources', 'RtdbOracleCLI', 'RtdbWave2Probes.swift'),
          join(
            RTDB_CLI_DIR,
            'Sources',
            'RtdbOracleCLI',
            'RtdbWave4NavigationAndSnapshotProbes.swift',
          ),
          join(
            RTDB_CLI_DIR,
            'Sources',
            'RtdbOracleCLI',
            'RtdbWave4ListenersAndOnDisconnectProbes.swift',
          ),
        ];
        const rtdbParseRes = spawnSync(swiftParser, ['-parse', ...rtdbSwiftFiles], {
          encoding: 'utf8',
        });
        expect(rtdbParseRes.status, `${rtdbParseRes.stdout}\n${rtdbParseRes.stderr}`).toBe(0);
      }
    },
    90_000,
  );

  it('forwards Wave 4 child-query RTDB rules, cleans up Wave 4 Auth UIDs on success and failure, and routes macos-latest in planCaptureRun', async () => {
    const navRules = buildIosRtdbNavigationAndChildQueryRules();
    expect(navRules).toEqual({
      '.read': true,
      '.write': true,
      players: {
        '.indexOn': ['score', 'tier'],
      },
    });

    const baselineRtdb = JSON.stringify({
      rules: {
        '.read': false,
        '.write': false,
        pyric_oracle: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    });
    const mergedNav = mergeOracleRtdbRules(baselineRtdb, {
      runId: 'ios_wave4_nav',
      rules: navRules,
      stripTopLevelGrants: true,
    });
    expect(mergedNav.outcome).toBe('merged');
    if (mergedNav.outcome === 'merged') {
      const parsedMerged = JSON.parse(mergedNav.next) as {
        rules: { pyric_oracle: Record<string, unknown> };
      };
      expect('.read' in parsedMerged.rules.pyric_oracle).toBe(false);
      expect(parsedMerged.rules.pyric_oracle.ios_wave4_nav).toEqual(navRules);
    }

    let capturedRtdbOpts: IosRtdbSessionOptions | undefined;
    const rtdbBehavior = await runIosOracleProbe({
      probeId: 'rtdb-swift-navigation-push-priorities-and-snapshots',
      mode: 'macos-rtdb-cli',
      rtdbRunRules: navRules,
      deps: {
        platform: 'darwin',
        env: {
          PYRIC_ORACLE_RTDB_URL: 'https://pyric-oracle-rtdb-2.firebaseio.com',
        },
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:111:ios:abc',
          messagingSenderId: '111',
        }),
        deployScopedRtdbSession: async (_sa, _dbUrl, _runId, fn, opts) => {
          capturedRtdbOpts = opts;
          return fn();
        },
        executeRtdbCli: (req) => {
          writeFileSync(
            req.outputPath,
            JSON.stringify({
              orderByChildEqualToGoldWithKeyP3: ['p3'],
              existsAfterSetNil: false,
            }),
          );
          return '';
        },
      },
    });

    expect(capturedRtdbOpts).toEqual({
      rules: navRules,
      stripTopLevelGrants: true,
    });
    expect(rtdbBehavior).toEqual({
      orderByChildEqualToGoldWithKeyP3: ['p3'],
      existsAfterSetNil: false,
    });

    let customTokenCalls = 0;
    const deletedUids: string[] = [];
    const mockAdmin: IosAdminAuthAdapter = {
      createCustomToken: async () => {
        customTokenCalls += 1;
        return 'unexpected-token';
      },
      deleteUser: async (uid) => {
        deletedUids.push(uid);
      },
      dispose: async () => {},
    };

    const authBehavior = await runIosOracleProbe({
      probeId: 'auth-swift-instance-linking-reauth-and-oauth-credentials',
      mode: 'ios-sim-auth',
      needsCustomToken: false,
      deps: {
        platform: 'darwin',
        env: {},
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:222:ios:def',
          messagingSenderId: '222',
        }),
        openAdminAuth: async () => mockAdmin,
        queryAvailableSimulatorsJson: () =>
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                { udid: 'SIM-WAVE4', name: 'iPhone 17', state: 'Booted', isAvailable: true },
              ],
            },
          }),
        executeAuthSim: (req) => {
          const bundled = JSON.parse(
            readFileSync(
              join(
                req.stagedPackageDir,
                'Tests',
                'AuthOracleSimTests',
                'Resources',
                'oracle-input.json',
              ),
              'utf8',
            ),
          ) as { probeId: string; customToken: string; expectedCustomUid: string };
          expect(bundled.probeId).toBe('auth-swift-instance-linking-reauth-and-oauth-credentials');
          expect(bundled.customToken).toBe('');
          expect(bundled.expectedCustomUid).toBe('');

          const encoded = Buffer.from(
            JSON.stringify({
              linkPreservedUid: true,
              googleCredentialProvider: 'google.com',
              _cleanupUids: ['linked-anon-uid-1', 'collision-seed-uid-2'],
            }),
            'utf8',
          ).toString('base64');
          return [
            'PYRIC_IOS_ORACLE_CLEANUP_UID:linked-anon-uid-1',
            'PYRIC_IOS_ORACLE_CLEANUP_UID:collision-seed-uid-2',
            `PYRIC_IOS_ORACLE_RESULT_B64:${encoded}`,
          ].join('\n');
        },
      },
    });

    expect(customTokenCalls).toBe(0);
    expect(authBehavior).toEqual({
      linkPreservedUid: true,
      googleCredentialProvider: 'google.com',
    });
    expect(deletedUids).toEqual(['linked-anon-uid-1', 'collision-seed-uid-2']);

    const failureDeletedUids: string[] = [];
    await expect(
      runIosOracleProbe({
        probeId: 'auth-swift-instance-linking-reauth-and-oauth-credentials',
        mode: 'ios-sim-auth',
        needsCustomToken: false,
        deps: {
          platform: 'darwin',
          env: {},
          loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
          resolveWebConfig: async () => ({
            apiKey: 'demo-key',
            authDomain: 'demo-oracle-project.firebaseapp.com',
            projectId: 'demo-oracle-project',
            appId: '1:222:ios:def',
            messagingSenderId: '222',
          }),
          openAdminAuth: async () => ({
            createCustomToken: async () => 'unexpected',
            deleteUser: async (uid) => {
              failureDeletedUids.push(uid);
            },
            dispose: async () => {},
          }),
          queryAvailableSimulatorsJson: () =>
            JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                  { udid: 'SIM-WAVE4-FAIL', name: 'iPhone 17', state: 'Booted', isAvailable: true },
                ],
              },
            }),
          executeAuthSim: () => {
            const failure = new Error(
              'xcodebuild AuthOracleSimTests exited with status 65',
            ) as Error & { output?: string };
            failure.output =
              'Suite started\nPYRIC_IOS_ORACLE_CLEANUP_UID:wave4-midrun-anon-uid\nFailed';
            throw failure;
          },
        },
      }),
    ).rejects.toThrow(/status 65/);
    expect(failureDeletedUids).toEqual(['wave4-midrun-anon-uid']);

    const baseCiEnv = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
    };
    const stagedTargets = STAGED_IOS_WAVE4_PROBES.map((name) => ({
      rig: 'ios-sdk-probes',
      observationName: name,
      filterFlag: '--probe' as const,
      filterValue: name,
    }));

    const ubuntuPlan = await planCaptureRun(
      { ...baseCiEnv, CAPTURE_RUNNER_OS: 'ubuntu-latest' },
      { stagedTargets, pendingPrefixRigs: [] },
    );
    expect(ubuntuPlan.invocations).toEqual([]);

    const macosPlan = await planCaptureRun(
      { ...baseCiEnv, CAPTURE_RUNNER_OS: 'macos-latest' },
      { stagedTargets, pendingPrefixRigs: [] },
    );
    expect(macosPlan.invocations.map((inv) => inv.args)).toEqual(
      STAGED_IOS_WAVE4_PROBES.map((name) => ['--write', '--probe', name]),
    );
  });
});
