import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { loadObservations } from '../../observations/load.ts';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { resolveCaptureBundleDirs } from '../../../../scripts/ci/oracle-capture-open-pr.ts';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { probe as authSwiftSeedProbe } from '../../probes/auth-swift/auth-swift-anonymous-and-custom-token-session.ts';
import { probe as rtdbSwiftSeedProbe } from '../../probes/rtdb-swift/rtdb-swift-dedicated-crud-and-query-order.ts';
import { rig as iosSdkProbesRig } from '../../rigs/ios-sdk-probes.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import {
  buildIosRtdbRunRules,
  runIosOracleProbe,
  type IosAdminAuthAdapter,
} from '../../src/ios-oracle-runtime.ts';
import {
  buildAuthSimXcodebuildArgs,
  buildRtdbSwiftRunArgs,
  extractIosOracleCleanupUids,
  extractIosOracleResultFromOutput,
  selectAvailableIosSimulatorDestination,
  stageIosPackageTemplate,
} from '../../src/ios-oracle-simulator.ts';
import {
  IOS_SDK_PROBES_RIG_CONFIG,
  runIosSdkProbesCli,
} from '../../src/ios-sdk-probes.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { resolvedIosSdkVersion } from '../../src/package-version.ts';
import { executeModularProbes, loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..', '..');
const NATIVE_IOS_ROOT = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle');

const SYNTHETIC_SERVICE_ACCOUNT: OracleServiceAccount = {
  kind: 'application-default',
  project_id: 'demo-oracle-project',
  client_email: 'capture-sa@demo-oracle-project.iam.gserviceaccount.com',
  credential: {
    getAccessToken: async () => ({ access_token: 'synthetic-token', expires_in: 3600 }),
  },
};

describe('ios-sdk-probes manifest, SwiftPM version pins, and staged probes', () => {
  it('pins identical firebase-ios-sdk versions across sdk-version.properties and both Package.swift manifests', () => {
    const version = resolvedIosSdkVersion();
    expect(version).toBe('13.2.0');

    const rtdbManifest = readFileSync(join(NATIVE_IOS_ROOT, 'rtdb-cli', 'Package.swift'), 'utf8');
    const authManifest = readFileSync(join(NATIVE_IOS_ROOT, 'auth-sim', 'Package.swift'), 'utf8');

    expect(rtdbManifest).toContain(`exact: "${version}"`);
    expect(rtdbManifest).toContain('traits: []');
    expect(rtdbManifest).toContain('name: "FirebaseDatabase"');
    expect(rtdbManifest).not.toContain('FirebaseAuth');
    expect(rtdbManifest).toContain('.swiftLanguageMode(.v5)');
    expect(rtdbManifest).toMatch(/\],\s*swiftLanguageModes: \[\.v5\]\s*\)\s*$/);

    expect(authManifest).toContain(`exact: "${version}"`);
    expect(authManifest).toContain('traits: []');
    expect(authManifest).toContain('name: "FirebaseAuth"');
    expect(authManifest).toContain('.copy("Resources/oracle-input.json")');
    expect(authManifest).toContain('.swiftLanguageMode(.v5)');
    expect(authManifest).toMatch(/\],\s*swiftLanguageModes: \[\.v5\]\s*\)\s*$/);
  });

  it('registers ios-sdk-probes on macos-latest and discovers all auth-swift and rtdb-swift probes', async () => {
    expect(iosSdkProbesRig.runnerOs).toBe('macos-latest');
    expect(iosSdkProbesRig.freshness.versionField).toBe('iosSdkVersion');
    expect(iosSdkProbesRig.requires.projectFeatures).toContain(
      'Email/Password sign-in enabled on the dedicated oracle project.',
    );
    expect(authSwiftSeedProbe.rig).toBe('ios-sdk-probes');
    expect(rtdbSwiftSeedProbe.rig).toBe('ios-sdk-probes');

    const manifests = await loadRigManifests();
    const found = manifests.find((m) => m.id === 'ios-sdk-probes');
    expect(found?.runnerOs).toBe('macos-latest');
    expect(loadObservations().length).toBeGreaterThan(0);

    const expectedProbeIds = [
      'auth-swift-anonymous-and-custom-token-session',
      'auth-swift-email-password-and-error-codes',
      'auth-swift-instance-linking-reauth-and-oauth-credentials',
      'auth-swift-profile-token-claims-and-delete-lifecycle',
      'rtdb-swift-dedicated-crud-and-query-order',
      'rtdb-swift-listeners-transactions-connection-and-ondisconnect',
      'rtdb-swift-navigation-push-priorities-and-snapshots',
      'rtdb-swift-queries-ranges-limits-and-permission-denied',
      'rtdb-swift-writes-autoid-servervalue-and-transactions',
    ];

    const loaded = (await loadModularProbes('ios-sdk-probes')).filter(
      (entry) => entry.surfaceDir !== 'firestore-swift',
    );
    expect(loaded.map((entry) => entry.id)).toEqual(expectedProbeIds);

    expectStagedUntilCaptured(expectedProbeIds, {
      rig: 'ios-sdk-probes',
      filterFlag: '--probe',
    });
  });
});

describe('ios-oracle-simulator discovery, command args, and base64 extraction', () => {
  it('prefers booted iPhone devices and otherwise picks the newest available iOS Simulator runtime', () => {
    const bootedFixture = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [
          { udid: 'WATCH-1', name: 'Apple Watch Series 11', state: 'Booted', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { udid: 'IPHONE-18-BOOTED', name: 'iPhone 16', state: 'Booted', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'IPHONE-26-SHUTDOWN', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
        ],
      },
    });
    const pickedBooted = selectAvailableIosSimulatorDestination(bootedFixture);
    expect(pickedBooted).toEqual({
      udid: 'IPHONE-18-BOOTED',
      name: 'iPhone 16',
      runtimeKey: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      destination: 'platform=iOS Simulator,id=IPHONE-18-BOOTED',
    });

    const unbootedFixture = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
          { udid: 'OLD-26-2', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'UNAVAILABLE-ID', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: false },
          { udid: 'IPAD-26-5', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
          { udid: 'NEW-26-5', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
        ],
      },
    });
    const pickedNewest = selectAvailableIosSimulatorDestination(unbootedFixture);
    expect(pickedNewest).toEqual({
      udid: 'NEW-26-5',
      name: 'iPhone 17',
      runtimeKey: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      destination: 'platform=iOS Simulator,id=NEW-26-5',
    });

    expect(() => selectAvailableIosSimulatorDestination(JSON.stringify({ devices: {} }))).toThrow(
      /No available iOS Simulator device/,
    );
  });

  it('builds headless SwiftPM CLI args and ad-hoc simulator xcodebuild test args', () => {
    const rtdbArgs = buildRtdbSwiftRunArgs({
      stagedPackageDir: '/tmp/staged/rtdb-cli',
      scratchCacheDir: '/tmp/cache/rtdb',
      inputPath: '/tmp/staged/in.json',
      outputPath: '/tmp/staged/out.json',
      env: {},
    });
    expect(rtdbArgs).toEqual([
      'run',
      '--package-path',
      '/tmp/staged/rtdb-cli',
      '--scratch-path',
      '/tmp/cache/rtdb',
      'RtdbOracleCLI',
      '--input',
      '/tmp/staged/in.json',
      '--output',
      '/tmp/staged/out.json',
    ]);

    const authArgs = buildAuthSimXcodebuildArgs({
      stagedPackageDir: '/tmp/staged/auth-sim',
      derivedDataDir: '/tmp/staged/DerivedData',
      clonedPackagesDir: '/tmp/cache/spm',
      destination: 'platform=iOS Simulator,id=SIM-123',
      env: {},
    });
    expect(authArgs).toContain('CODE_SIGNING_ALLOWED=YES');
    expect(authArgs).toContain('CODE_SIGNING_REQUIRED=NO');
    expect(authArgs).toContain('platform=iOS Simulator,id=SIM-123');
    expect(authArgs).toContain(
      '-only-testing:AuthOracleHostedTests/AuthOracleHostedTests/testCaptureSelectedOracleProbe',
    );
  });

  it('extracts base64 JSON payloads from noisy xcodebuild output and rejects symlinks when staging templates', () => {
    const encoded = Buffer.from(
      JSON.stringify({ anonymousIsAnonymous: true, signInProvider: 'custom' }),
      'utf8',
    ).toString('base64');
    const noisyLog = [
      'Test Suite AuthOracleSimTests started.',
      `2026-11-20 22:00:00.000 xctest[1234:5678] PYRIC_IOS_ORACLE_RESULT_B64:${encoded}`,
      'Test Case -[AuthOracleSimTests testCaptureSelectedOracleProbe] passed (1.234 seconds).',
    ].join('\n');

    expect(extractIosOracleResultFromOutput(noisyLog)).toEqual({
      anonymousIsAnonymous: true,
      signInProvider: 'custom',
    });
    expect(() => extractIosOracleResultFromOutput('no marker line')).toThrow(
      /Missing PYRIC_IOS_ORACLE_RESULT_B64/,
    );

    const scratch = createPrivateJobTmpDir('ios-stage-ut');
    try {
      const srcDir = join(scratch, 'src');
      const dstDir = join(scratch, 'dst');
      mkdirSync(join(srcDir, '.build'), { recursive: true });
      writeFileSync(join(srcDir, '.build', 'ignored.txt'), 'skip\n');
      writeFileSync(join(srcDir, 'Package.resolved'), 'skip\n');
      writeFileSync(join(srcDir, 'Package.swift'), '// manifest\n');

      stageIosPackageTemplate(srcDir, dstDir);
      expect(existsSync(join(dstDir, 'Package.swift'))).toBe(true);
      expect(existsSync(join(dstDir, '.build'))).toBe(false);
      expect(existsSync(join(dstDir, 'Package.resolved'))).toBe(false);

      symlinkSync(join(srcDir, 'Package.swift'), join(srcDir, 'link.swift'));
      expect(() => stageIosPackageTemplate(srcDir, join(scratch, 'dst-2'))).toThrow(
        /Refusing symlink/,
      );
    } finally {
      removePrivateJobTmpDir(scratch);
    }
  });
});

describe('runIosOracleProbe and planCaptureRun macos-latest orchestration', () => {
  it('fails closed on non-darwin hosts before invoking credentials or build tools', async () => {
    let credentialCalled = false;
    await expect(
      runIosOracleProbe({
        probeId: 'rtdb-swift-dedicated-crud-and-query-order',
        mode: 'macos-rtdb-cli',
        deps: {
          platform: 'linux',
          loadServiceAccount: async () => {
            credentialCalled = true;
            return SYNTHETIC_SERVICE_ACCOUNT;
          },
        },
      }),
    ).rejects.toThrow(/requires macOS \(darwin\)/);
    expect(credentialCalled).toBe(false);
  });

  it('executes macos-rtdb-cli probes inside scoped RTDB rules sessions and rejects default RTDB URLs', async () => {
    await expect(
      runIosOracleProbe({
        probeId: 'rtdb-swift-dedicated-crud-and-query-order',
        mode: 'macos-rtdb-cli',
        deps: {
          platform: 'darwin',
          env: {
            PYRIC_ORACLE_RTDB_URL: 'https://demo-oracle-project-default-rtdb.firebaseio.com',
          },
          loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
          resolveWebConfig: async () => ({
            apiKey: 'demo-key',
            authDomain: 'demo-oracle-project.firebaseapp.com',
            projectId: 'demo-oracle-project',
            appId: '1:111:ios:abc',
            messagingSenderId: '111',
          }),
        },
      }),
    ).rejects.toThrow(/never the project default instance/i);

    let sessionWrapped = false;
    let stagedDirAfterRun = '';
    const rtdbResult = await runIosOracleProbe({
      probeId: 'rtdb-swift-dedicated-crud-and-query-order',
      mode: 'macos-rtdb-cli',
      deps: {
        platform: 'darwin',
        env: {
          PYRIC_ORACLE_RTDB_URL: 'https://pyric-oracle-rtdb-dedicated.firebaseio.com',
        },
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:111:ios:abc',
          messagingSenderId: '111',
        }),
        deployScopedRtdbSession: async (_sa, databaseUrl, runId, fn) => {
          expect(databaseUrl).toBe('https://pyric-oracle-rtdb-dedicated.firebaseio.com');
          expect(runId).toMatch(/^ios_[0-9a-f]{32}$/);
          expect(buildIosRtdbRunRules()).toEqual({
            '.read': true,
            '.write': true,
            items: { '.indexOn': ['score'] },
          });
          sessionWrapped = true;
          return fn();
        },
        executeRtdbCli: (req) => {
          stagedDirAfterRun = req.stagedPackageDir;
          const inputPayload = JSON.parse(readFileSync(req.inputPath, 'utf8')) as Record<
            string,
            unknown
          >;
          expect(inputPayload.probeId).toBe('rtdb-swift-dedicated-crud-and-query-order');
          expect(inputPayload.databaseUrl).toBe(
            'https://pyric-oracle-rtdb-dedicated.firebaseio.com',
          );
          writeFileSync(
            req.outputPath,
            JSON.stringify({
              betaIncrementedScore: 10,
              orderedKeys: ['beta', 'gamma'],
              removedExistsAfterCleanup: false,
            }),
          );
          return '';
        },
      },
    });

    expect(sessionWrapped).toBe(true);
    expect(existsSync(stagedDirAfterRun)).toBe(false);
    expect(rtdbResult).toEqual({
      betaIncrementedScore: 10,
      orderedKeys: ['beta', 'gamma'],
      removedExistsAfterCleanup: false,
    });
  });

  it('executes ios-sim-auth probes, stages bundled input JSON, and deletes all tracked Auth UIDs in finally', async () => {
    const deletedUids: string[] = [];
    let disposed = false;
    const mockAdmin: IosAdminAuthAdapter = {
      createCustomToken: async (uid, claims) => {
        expect(claims).toEqual({ role: 'tester', tier: 2 });
        return `minted-token-for-${uid}`;
      },
      deleteUser: async (uid) => {
        deletedUids.push(uid);
      },
      dispose: async () => {
        disposed = true;
      },
    };

    const behavior = await runIosOracleProbe({
      probeId: 'auth-swift-anonymous-and-custom-token-session',
      mode: 'ios-sim-auth',
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
                { udid: 'SIM-UDID-99', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        executeAuthSim: (req) => {
          expect(req.destination).toBe('platform=iOS Simulator,id=SIM-UDID-99');
          const resourceJson = JSON.parse(
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
          ) as { mode: string; expectedCustomUid: string; customToken: string };
          expect(resourceJson.mode).toBe('live');
          expect(resourceJson.customToken).toBe(
            `minted-token-for-${resourceJson.expectedCustomUid}`,
          );
          const payload = Buffer.from(
            JSON.stringify({
              anonymousIsAnonymous: true,
              customUidMatchesExpected: true,
              signInProvider: 'custom',
              _cleanupUids: ['anon-uid-1', resourceJson.expectedCustomUid],
            }),
            'utf8',
          ).toString('base64');
          return `PYRIC_IOS_ORACLE_RESULT_B64:${payload}`;
        },
      },
    });

    expect(behavior).toEqual({
      anonymousIsAnonymous: true,
      customUidMatchesExpected: true,
      signInProvider: 'custom',
    });
    expect(deletedUids).toContain('anon-uid-1');
    expect(deletedUids.length).toBe(2);
    expect(disposed).toBe(true);

    const midFailureDeleted: string[] = [];
    expect(
      extractIosOracleCleanupUids(
        'log prefix\nPYRIC_IOS_ORACLE_CLEANUP_UID:anon-midrun-77\nPYRIC_IOS_ORACLE_CLEANUP_UID:anon-midrun-77\n',
      ),
    ).toEqual(['anon-midrun-77']);

    await expect(
      runIosOracleProbe({
        probeId: 'auth-swift-anonymous-and-custom-token-session',
        mode: 'ios-sim-auth',
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
            createCustomToken: async (uid) => `token-${uid}`,
            deleteUser: async (uid) => {
              midFailureDeleted.push(uid);
            },
            dispose: async () => {},
          }),
          queryAvailableSimulatorsJson: () =>
            JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                  { udid: 'SIM-UDID-99', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
                ],
              },
            }),
          executeAuthSim: () => {
            const failure = new Error('xcodebuild AuthOracleSimTests exited with status 65') as Error & {
              output?: string;
            };
            failure.output =
              'Test Case started\nPYRIC_IOS_ORACLE_CLEANUP_UID:anon-midrun-leak-42\nAssertion failed';
            throw failure;
          },
        },
      }),
    ).rejects.toThrow(/status 65/);
    expect(midFailureDeleted).toContain('anon-midrun-leak-42');
    expect(midFailureDeleted.length).toBe(2);
  });

  it('writes iosSdkVersion envelopes and filters macos-latest vs ubuntu-latest legs in planCaptureRun', async () => {
    const obsTmp = createPrivateJobTmpDir('ios-obs-ut');
    try {
      await runIosSdkProbesCli([], { CI: '1' }, false);

      await executeModularProbes({
        config: IOS_SDK_PROBES_RIG_CONFIG,
        sdkVersion: resolvedIosSdkVersion(),
        projectId: 'demo-oracle-project',
        observationsRoot: obsTmp,
        probes: [
          {
            id: 'rtdb-swift-dedicated-crud-and-query-order',
            surfaceDir: 'rtdb-swift',
            probe: {
              description: 'Synthetic iOS RTDB probe.',
              matrixRow: '',
              rowIds: [],
              pendingRowLink: true,
              rig: 'ios-sdk-probes',
              observe: async () => ({ orderedKeys: ['beta', 'gamma'] }),
            },
          },
        ],
      });

      const written = JSON.parse(
        readFileSync(
          join(obsTmp, 'rtdb-swift', 'rtdb-swift-dedicated-crud-and-query-order.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(written.iosSdkVersion).toBe('13.2.0');
      expect(written.behavior).toEqual({ orderedKeys: ['beta', 'gamma'] });
    } finally {
      removePrivateJobTmpDir(obsTmp);
    }

    const baseCiEnv = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
    };
    const mixedTargets = [
      {
        rig: 'sdk-probes',
        observationName: 'rtdb-modular-sample',
        filterFlag: '--probe' as const,
        filterValue: 'rtdb-modular-sample',
      },
      {
        rig: 'ios-sdk-probes',
        observationName: 'auth-swift-anonymous-and-custom-token-session',
        filterFlag: '--probe' as const,
        filterValue: 'auth-swift-anonymous-and-custom-token-session',
      },
    ];

    const linuxDefaultPlan = await planCaptureRun(
      { ...baseCiEnv, RUNNER_OS: 'Linux' },
      { stagedTargets: mixedTargets, pendingPrefixRigs: [] },
    );
    expect(linuxDefaultPlan.invocations.map((inv) => inv.rig)).toEqual(['sdk-probes']);

    const macosPlan = await planCaptureRun(
      { ...baseCiEnv, CAPTURE_RUNNER_OS: 'macos-latest' },
      { stagedTargets: mixedTargets, pendingPrefixRigs: [] },
    );
    expect(macosPlan.invocations).toEqual([
      {
        rig: 'ios-sdk-probes',
        script: 'packages/conformance/src/ios-sdk-probes.ts',
        args: ['--write', '--probe', 'auth-swift-anonymous-and-custom-token-session'],
        wifTier: 'capture-write',
        runnerOs: 'macos-latest',
      },
    ]);

    const multiLegTmp = createPrivateJobTmpDir('ios-multileg-ut');
    try {
      const multiLegRoot = join(multiLegTmp, 'bundle');
      mkdirSync(join(multiLegRoot, 'oracle-capture-observations-macos-latest-1'), {
        recursive: true,
      });
      mkdirSync(join(multiLegRoot, 'oracle-capture-observations-ubuntu-latest-1'), {
        recursive: true,
      });
      writeFileSync(
        join(multiLegRoot, 'oracle-capture-observations-macos-latest-1', 'manifest.json'),
        '{}\n',
      );
      writeFileSync(
        join(multiLegRoot, 'oracle-capture-observations-ubuntu-latest-1', 'manifest.json'),
        '{}\n',
      );
      expect(resolveCaptureBundleDirs(multiLegRoot)).toEqual([
        join(multiLegRoot, 'oracle-capture-observations-macos-latest-1'),
        join(multiLegRoot, 'oracle-capture-observations-ubuntu-latest-1'),
      ]);
    } finally {
      removePrivateJobTmpDir(multiLegTmp);
    }
  });
});
