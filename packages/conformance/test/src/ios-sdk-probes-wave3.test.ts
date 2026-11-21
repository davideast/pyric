import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { probe as firestoreBatchTxErrorsProbe } from '../../probes/firestore-swift/firestore-swift-batches-transactions-offline-and-errors.ts';
import { probe as firestoreCrudCodecsProbe } from '../../probes/firestore-swift/firestore-swift-crud-merge-sentinels-and-codecs.ts';
import { probe as firestoreQueriesAggProbe } from '../../probes/firestore-swift/firestore-swift-queries-cursors-filters-and-aggregations.ts';
import { rig as iosSdkProbesRig } from '../../rigs/ios-sdk-probes.ts';
import {
  runIosOracleProbe,
  type IosAdminAuthAdapter,
} from '../../src/ios-oracle-runtime.ts';
import {
  buildFirestoreSimXcodebuildArgs,
  defaultExecuteFirestoreSim,
  defaultQueryAvailableSimulatorsJson,
  extractIosOracleResultFromOutput,
  selectAvailableIosSimulatorDestination,
  stageIosPackageTemplate,
} from '../../src/ios-oracle-simulator.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { firestoreOracleTarget } from '../../src/oracle-rules-session.ts';
import { resolvedIosSdkVersion } from '../../src/package-version.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..', '..');
const NATIVE_IOS_ROOT = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle');
const FIRESTORE_SIM_DIR = join(NATIVE_IOS_ROOT, 'firestore-sim');

const WAVE3_FIRESTORE_PROBE_IDS = [
  'firestore-swift-batches-transactions-offline-and-errors',
  'firestore-swift-crud-merge-sentinels-and-codecs',
  'firestore-swift-queries-cursors-filters-and-aggregations',
];

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

describe('Wave 3 firestore-swift ios-sdk-probes manifest, Swift package, and staged probes', () => {
  it('wires firestore-swift surface, firestore-sim Package.swift, and staged probe descriptors', async () => {
    const version = resolvedIosSdkVersion();
    expect(version).toBe('13.2.0');

    const surfaceJson = JSON.parse(
      readFileSync(join(CONFORMANCE_ROOT, 'surfaces', 'firestore-swift.json'), 'utf8'),
    ) as { captureRigs?: unknown };
    expect(surfaceJson.captureRigs).toEqual(['ios-sdk-probes']);

    expect(iosSdkProbesRig.requires.projectFeatures).toContain(
      'Cloud Firestore default database provisioned in Native mode.',
    );

    const firestoreManifest = readFileSync(join(FIRESTORE_SIM_DIR, 'Package.swift'), 'utf8');
    expect(firestoreManifest).toContain(`exact: "${version}"`);
    expect(firestoreManifest).toContain('traits: ["Firestore"]');
    expect(firestoreManifest).toContain('name: "FirebaseCore"');
    expect(firestoreManifest).toContain('name: "FirebaseAuth"');
    expect(firestoreManifest).toContain('name: "FirebaseFirestore"');
    expect(firestoreManifest).toContain('.copy("Resources/oracle-input.json")');
    expect(firestoreManifest).toContain('.swiftLanguageMode(.v5)');
    expect(firestoreManifest).toMatch(/\],\s*swiftLanguageModes: \[\.v5\]\s*\)\s*$/);

    const wave3Descriptors = [
      firestoreBatchTxErrorsProbe,
      firestoreCrudCodecsProbe,
      firestoreQueriesAggProbe,
    ];
    for (const descriptor of wave3Descriptors) {
      expect(descriptor.rig).toBe('ios-sdk-probes');
      expect(descriptor.pendingRowLink).toBe(true);
      expect(descriptor.matrixRow).toBe('');
      expect(descriptor.rowIds).toEqual([]);
      expect(descriptor.requires).toEqual([
        'web-config',
        'firestore-rules',
        'admin-auth',
        'admin-firestore',
      ]);
      if (process.platform !== 'darwin') {
        await expect(descriptor.observe()).rejects.toThrow(/requires macOS \(darwin\)/);
      }
    }

    const loadedFirestore = (await loadModularProbes('ios-sdk-probes')).filter(
      (entry) => entry.surfaceDir === 'firestore-swift' && WAVE3_FIRESTORE_PROBE_IDS.includes(entry.id),
    );
    expect(loadedFirestore.map((entry) => entry.id)).toEqual(WAVE3_FIRESTORE_PROBE_IDS);

    expectStagedUntilCaptured(WAVE3_FIRESTORE_PROBE_IDS, {
      rig: 'ios-sdk-probes',
      filterFlag: '--probe',
    });
  });

  it(
    'verifies Swift switch arms, cleanup discipline, single-field predicates, and Swift syntax parsing',
    () => {
    const runnerSwift = readFileSync(
      join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreOracleProbeRunner.swift'),
      'utf8',
    );
    const crudSwift = readFileSync(
      join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreCrudAndCodecProbes.swift'),
      'utf8',
    );
    const querySwift = readFileSync(
      join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreQueryAndAggregateProbes.swift'),
      'utf8',
    );
    const batchTxSwift = readFileSync(
      join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreBatchTxAndErrorProbes.swift'),
      'utf8',
    );

    for (const probeId of WAVE3_FIRESTORE_PROBE_IDS) {
      expect(runnerSwift).toContain(`case "${probeId}":`);
    }
    expect(runnerSwift).toContain('PYRIC_IOS_ORACLE_CLEANUP_UID:');
    expect(runnerSwift).toContain('signIn(withCustomToken: customToken)');
    expect(runnerSwift).toContain('db.terminate()');
    expect(runnerSwift).toContain('auth.signOut()');
    expect(runnerSwift).toContain('deleteAppAsync(app)');

    expect(crudSwift).toContain('FieldValue.serverTimestamp()');
    expect(crudSwift).toContain('mergeFields:');
    expect(crudSwift).toContain('FieldValue.increment(');
    expect(crudSwift).toContain('FieldValue.arrayUnion(');
    expect(crudSwift).toContain('FieldValue.arrayRemove(');
    expect(crudSwift).toContain('FieldValue.delete()');
    expect(crudSwift).toContain('deleteDocsBestEffort(createdRefs)');

    expect(querySwift).toContain('Filter.orFilter(');
    expect(querySwift).toContain('AggregateField.count()');
    expect(querySwift).toContain('AggregateField.sum("score")');
    expect(querySwift).toContain('AggregateField.average("score")');
    expect(querySwift).toContain('addSnapshotListener(includeMetadataChanges: false)');
    expect(querySwift).toContain('registration.remove()');
    expect(querySwift).toContain('deleteDocsBestEffort(createdRefs)');

    expect(batchTxSwift).toContain('db.batch()');
    expect(batchTxSwift).toContain('db.runTransaction');
    expect(batchTxSwift).toContain('FirestoreErrorCode.notFound.rawValue');
    expect(batchTxSwift).toContain('db.disableNetwork()');
    expect(batchTxSwift).toContain('db.waitForPendingWrites()');
    expect(batchTxSwift).toContain('FirestoreErrorCode.permissionDenied.rawValue');
    expect(batchTxSwift).toContain('db.clearPersistence()');

    const swiftParser = detectSwiftFrontendForParse();
    if (swiftParser !== null) {
      const swiftFiles = [
        join(FIRESTORE_SIM_DIR, 'Package.swift'),
        join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreOracleProbeRunner.swift'),
        join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreCrudAndCodecProbes.swift'),
        join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreQueryAndAggregateProbes.swift'),
        join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreBatchTxAndErrorProbes.swift'),
        join(FIRESTORE_SIM_DIR, 'Tests', 'FirestoreOracleSimTests', 'FirestoreOracleSimTests.swift'),
      ];
      const parseRes = spawnSync(swiftParser, ['-parse', ...swiftFiles], { encoding: 'utf8' });
      expect(parseRes.status, `${parseRes.stdout}\n${parseRes.stderr}`).toBe(0);
    }
  },
  90_000,
  );

  it('stages firestore-sim, deploys scoped Firestore session, and deletes custom-token + streamed UIDs on success and failure', async () => {
    const xcodeArgs = buildFirestoreSimXcodebuildArgs({
      stagedPackageDir: '/tmp/staged/firestore-sim',
      derivedDataDir: '/tmp/cache/firestore-dd',
      clonedPackagesDir: '/tmp/cache/spm',
      destination: 'platform=iOS Simulator,id=SIM-FS-1',
      env: {},
    });
    expect(xcodeArgs).toEqual([
      'test',
      '-scheme',
      'PyricIosFirestoreOracle',
      '-destination',
      'platform=iOS Simulator,id=SIM-FS-1',
      '-derivedDataPath',
      '/tmp/cache/firestore-dd',
      '-clonedSourcePackagesDirPath',
      '/tmp/cache/spm',
      '-collect-test-diagnostics',
      'never',
      '-only-testing:FirestoreOracleSimTests/FirestoreOracleSimTests/testCaptureSelectedOracleProbe',
      'ONLY_ACTIVE_ARCH=YES',
      'COMPILER_INDEX_STORE_ENABLE=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGNING_ALLOWED=YES',
    ]);

    const fsTarget = firestoreOracleTarget();
    expect(fsTarget.service).toBe('Firestore');
    expect(fsTarget.freshRules).toContain('match /pyric_oracle/{run}/{anything=**}');

    const deletedUids: string[] = [];
    let deployedFirestoreRunId = '';
    let observedDerivedDataDir = '';

    const mockAdmin: IosAdminAuthAdapter = {
      createCustomToken: async (uid) => `custom-jwt-for-${uid}`,
      deleteUser: async (uid) => {
        deletedUids.push(uid);
      },
      dispose: async () => {},
    };

    const behavior = await runIosOracleProbe({
      probeId: 'firestore-swift-crud-merge-sentinels-and-codecs',
      mode: 'ios-sim-firestore',
      deps: {
        platform: 'darwin',
        env: {},
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:333:ios:fsapp',
          messagingSenderId: '333',
        }),
        openAdminAuth: async () => mockAdmin,
        queryAvailableSimulatorsJson: () =>
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                { udid: 'SIM-FS-WAVE3', name: 'iPhone 17', state: 'Booted', isAvailable: true },
              ],
            },
          }),
        deployScopedFirestoreSession: async (_sa, runId, fn) => {
          deployedFirestoreRunId = runId;
          return fn();
        },
        executeFirestoreSim: (req) => {
          observedDerivedDataDir = req.derivedDataDir;
          const bundled = JSON.parse(
            readFileSync(
              join(
                req.stagedPackageDir,
                'Tests',
                'FirestoreOracleSimTests',
                'Resources',
                'oracle-input.json',
              ),
              'utf8',
            ),
          ) as {
            mode: string;
            probeId: string;
            runId: string;
            customToken: string;
            expectedCustomUid: string;
          };
          expect(bundled.mode).toBe('live');
          expect(bundled.probeId).toBe('firestore-swift-crud-merge-sentinels-and-codecs');
          expect(bundled.runId).toBe(deployedFirestoreRunId);
          expect(bundled.expectedCustomUid).toBe(`pyric-ios-${deployedFirestoreRunId}`);
          expect(bundled.customToken).toBe(`custom-jwt-for-pyric-ios-${deployedFirestoreRunId}`);

          const encoded = Buffer.from(
            JSON.stringify({
              autoIdLength: 20,
              incrementedCount: 15,
              deletedExists: false,
              _cleanupUids: [bundled.expectedCustomUid],
            }),
            'utf8',
          ).toString('base64');
          return [
            `PYRIC_IOS_ORACLE_CLEANUP_UID:${bundled.expectedCustomUid}`,
            `PYRIC_IOS_ORACLE_RESULT_B64:${encoded}`,
          ].join('\n');
        },
      },
    });

    expect(deployedFirestoreRunId.startsWith('ios_')).toBe(true);
    expect(observedDerivedDataDir).toContain('xcode-firestore-derived-data');
    expect(behavior).toEqual({
      autoIdLength: 20,
      incrementedCount: 15,
      deletedExists: false,
    });
    expect(deletedUids).toEqual([`pyric-ios-${deployedFirestoreRunId}`]);

    // Verify failure-path UID cleanup when xcodebuild exits non-zero mid-probe.
    const failureDeleted: string[] = [];
    await expect(
      runIosOracleProbe({
        probeId: 'firestore-swift-batches-transactions-offline-and-errors',
        mode: 'ios-sim-firestore',
        deps: {
          platform: 'darwin',
          env: {},
          loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
          resolveWebConfig: async () => ({
            apiKey: 'demo-key',
            authDomain: 'demo-oracle-project.firebaseapp.com',
            projectId: 'demo-oracle-project',
            appId: '1:333:ios:fsapp',
            messagingSenderId: '333',
          }),
          openAdminAuth: async () => ({
            createCustomToken: async (uid) => `jwt-${uid}`,
            deleteUser: async (uid) => {
              failureDeleted.push(uid);
            },
            dispose: async () => {},
          }),
          queryAvailableSimulatorsJson: () =>
            JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                  { udid: 'SIM-FS-FAIL', name: 'iPhone 17', state: 'Booted', isAvailable: true },
                ],
              },
            }),
          deployScopedFirestoreSession: async (_sa, _runId, fn) => fn(),
          executeFirestoreSim: () => {
            const failure = new Error(
              'xcodebuild FirestoreOracleSimTests exited with status 65',
            ) as Error & { output?: string };
            failure.output =
              'Suite started\nPYRIC_IOS_ORACLE_CLEANUP_UID:fs-midrun-uid-99\nFailed';
            throw failure;
          },
        },
      }),
    ).rejects.toThrow(/status 65/);
    expect(failureDeleted).toContain('fs-midrun-uid-99');
    expect(failureDeleted.length).toBe(2);

    // Verify planCaptureRun routes staged firestore-swift probes exclusively to macos-latest.
    const baseCiEnv = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
    };
    const stagedTargets = WAVE3_FIRESTORE_PROBE_IDS.map((name) => ({
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
      WAVE3_FIRESTORE_PROBE_IDS.map((name) => ['--write', '--probe', name]),
    );
  });

  const shouldRunMacosSmoke =
    process.platform === 'darwin' && process.env.PYRIC_RUN_IOS_ORACLE_SMOKE === '1';

  it.skipIf(!shouldRunMacosSmoke)(
    'builds and executes FirestoreOracleSimTests in offline template mode on macOS Simulator',
    () => {
      const tmp = createPrivateJobTmpDir('ios-fs-smoke');
      try {
        const stagedDir = join(tmp, 'firestore-sim');
        stageIosPackageTemplate(FIRESTORE_SIM_DIR, stagedDir);
        const simSelection = selectAvailableIosSimulatorDestination(
          defaultQueryAvailableSimulatorsJson(process.env),
        );
        const sharedCache = join(homedir(), '.cache', 'pyric-ios-oracle-spm');
        const output = defaultExecuteFirestoreSim({
          stagedPackageDir: stagedDir,
          derivedDataDir: join(sharedCache, 'xcode-firestore-derived-data'),
          clonedPackagesDir: join(sharedCache, 'xcode-source-packages'),
          destination: simSelection.destination,
          env: process.env,
        });
        expect(extractIosOracleResultFromOutput(output)).toEqual({
          mode: 'template',
          ok: true,
        });
      } finally {
        removePrivateJobTmpDir(tmp);
      }
    },
    600_000,
  );
});
