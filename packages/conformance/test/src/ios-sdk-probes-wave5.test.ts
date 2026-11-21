import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { probe as firestoreWave5InstanceProbe } from '../../probes/firestore-swift/firestore-swift-instance-snapshots-inSync-and-codable.ts';
import { probe as firestoreWave5QueriesProbe } from '../../probes/firestore-swift/firestore-swift-inequality-cursors-collectionGroup-and-txRetry.ts';
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
  buildIosFirestoreRulesTarget,
  runIosOracleProbe,
  type IosAdminAuthAdapter,
  type IosFirestoreSessionOptions,
} from '../../src/ios-oracle-runtime.ts';
import { loadObservations } from '../../src/ledger.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { OracleRulesSession } from '../../src/oracle-rules-session.ts';
import { resolvedIosSdkVersion } from '../../src/package-version.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..', '..');
const FIRESTORE_SIM_DIR = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle', 'firestore-sim');

const STAGED_WAVE5_FIRESTORE_PROBE_IDS: readonly string[] = [];

const WAVE5_FIRESTORE_PROBE_IDS = [
  'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
  'firestore-swift-instance-snapshots-inSync-and-codable',
] as const;

const ALL_FIRESTORE_SWIFT_PROBE_IDS = [
  'firestore-swift-batches-transactions-offline-and-errors',
  'firestore-swift-crud-merge-sentinels-and-codecs',
  'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
  'firestore-swift-instance-snapshots-inSync-and-codable',
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

async function runSingleProcessSwiftParse(
  swiftParser: string,
  swiftFiles: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([swiftParser, '-parse', ...swiftFiles], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdoutText}\n${stderrText}` };
}

describe('Wave 5 firestore-swift ios-sdk-probes descriptors, scoped collectionGroup rules, and Swift syntax', () => {
  it('wires Wave 5 firestore-swift descriptors, discovers all 5 firestore-swift probes, and passes PR #1 / PR #2 registry validation', async () => {
    const wave5Descriptors = [firestoreWave5InstanceProbe, firestoreWave5QueriesProbe];
    for (const descriptor of wave5Descriptors) {
      expect(descriptor.rig).toBe('ios-sdk-probes');
      expect(descriptor.pendingRowLink).toBeUndefined();
      expect(descriptor.matrixRow.startsWith('firestore-swift#')).toBe(true);
      expect(descriptor.rowIds.length).toBeGreaterThan(0);
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
    expect(firestoreWave5InstanceProbe.matrixRow).toBe('firestore-swift#1');
    expect(firestoreWave5InstanceProbe.rowIds.length).toBe(38);
    expect(firestoreWave5QueriesProbe.matrixRow).toBe('firestore-swift#9');
    expect(firestoreWave5QueriesProbe.rowIds.length).toBe(21);

    const loadedFirestore = (await loadModularProbes('ios-sdk-probes')).filter(
      (entry) => entry.surfaceDir === 'firestore-swift',
    );
    expect(loadedFirestore.map((entry) => entry.id)).toEqual(ALL_FIRESTORE_SWIFT_PROBE_IDS);

    expectStagedUntilCaptured(STAGED_WAVE5_FIRESTORE_PROBE_IDS, {
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

    const registryProblems = validateCompatibilityRegistry({
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
    expect(registryProblems).toEqual([]);

    const iosVersion = resolvedIosSdkVersion();
    const byName = new Map(currentObservations.map((obs) => [obs.name, obs]));
    const wave5NamedProbes = [
      ['firestore-swift-instance-snapshots-inSync-and-codable', firestoreWave5InstanceProbe],
      ['firestore-swift-inequality-cursors-collectionGroup-and-txRetry', firestoreWave5QueriesProbe],
    ] as const;
    for (const [probeName, descriptor] of wave5NamedProbes) {
      const committed = byName.get(probeName);
      if (committed === undefined) {
        throw new Error(`Missing committed Wave 5 observation ${probeName}`);
      }
      expect(committed.iosSdkVersion).toBe(iosVersion);
      expect(committed.matrixRow).toBe(descriptor.matrixRow);
      expect(committed.rowIds).toEqual([...descriptor.rowIds]);
    }
  });

  it(
    'verifies Wave 5 Swift switch arms, Codable/vector/collectionGroup/TransactionOptions APIs, and async single-process Swift parsing',
    async () => {
      const runnerSwift = readFileSync(
        join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreOracleProbeRunner.swift'),
        'utf8',
      );
      const instanceSwift = readFileSync(
        join(
          FIRESTORE_SIM_DIR,
          'Sources',
          'PyricIosFirestoreOracle',
          'FirestoreWave5InstanceAndCodableProbes.swift',
        ),
        'utf8',
      );
      const queryTxSwift = readFileSync(
        join(
          FIRESTORE_SIM_DIR,
          'Sources',
          'PyricIosFirestoreOracle',
          'FirestoreWave5QueriesCollectionGroupAndTxProbes.swift',
        ),
        'utf8',
      );

      for (const probeId of WAVE5_FIRESTORE_PROBE_IDS) {
        expect(runnerSwift).toContain(`case "${probeId}":`);
      }

      expect(instanceSwift).toContain('@DocumentID');
      expect(instanceSwift).toContain('@ServerTimestamp');
      expect(instanceSwift).toContain('decoder: Firestore.Decoder()');
      expect(instanceSwift).toContain('ref.setData(from: value');
      expect(instanceSwift).toContain('Firestore.firestore()');
      expect(instanceSwift).toContain('MemoryCacheSettings()');
      expect(instanceSwift).toContain('useEmulator(withHost: "127.0.0.1", port: 8080)');
      expect(instanceSwift).toContain('addSnapshotsInSyncListener');
      expect(instanceSwift).toContain('addSnapshotListener(includeMetadataChanges: true)');
      expect(instanceSwift).toContain('SnapshotListenOptions()');
      expect(instanceSwift).toContain('withIncludeMetadataChanges(true)');
      expect(instanceSwift).toContain('FieldValue.vector(');
      expect(instanceSwift).toContain('db.loadBundle(');
      expect(instanceSwift).toContain('db.getQuery(named:');
      expect(instanceSwift).toContain('docAlpha.snapshots');

      expect(queryTxSwift).toContain('isNotEqualTo:');
      expect(queryTxSwift).toContain('isLessThan:');
      expect(queryTxSwift).toContain('isLessThanOrEqualTo:');
      expect(queryTxSwift).toContain('isGreaterThan:');
      expect(queryTxSwift).toContain('isGreaterThanOrEqualTo:');
      expect(queryTxSwift).toContain('arrayContainsAny:');
      expect(queryTxSwift).toContain('notIn:');
      expect(queryTxSwift).toContain('start(at:');
      expect(queryTxSwift).toContain('start(after:');
      expect(queryTxSwift).toContain('end(before:');
      expect(queryTxSwift).toContain('end(at:');
      expect(queryTxSwift).toContain('start(atDocument:');
      expect(queryTxSwift).toContain('end(atDocument:');
      expect(queryTxSwift).toContain('end(beforeDocument:');
      expect(queryTxSwift).toContain('db.collectionGroup(cgId)');
      expect(queryTxSwift).toContain('TransactionOptions()');
      expect(queryTxSwift).toContain('db.runTransaction(block)');
      expect(queryTxSwift).toContain('db.runTransaction(with: options, block: block)');
      expect(queryTxSwift).toContain('transaction.deleteDocument(');

      const swiftParser = detectSwiftFrontendForParse();
      if (swiftParser !== null) {
        const swiftFiles = [
          join(FIRESTORE_SIM_DIR, 'Package.swift'),
          join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreOracleProbeRunner.swift'),
          join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreCrudAndCodecProbes.swift'),
          join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreQueryAndAggregateProbes.swift'),
          join(FIRESTORE_SIM_DIR, 'Sources', 'PyricIosFirestoreOracle', 'FirestoreBatchTxAndErrorProbes.swift'),
          join(
            FIRESTORE_SIM_DIR,
            'Sources',
            'PyricIosFirestoreOracle',
            'FirestoreWave5InstanceAndCodableProbes.swift',
          ),
          join(
            FIRESTORE_SIM_DIR,
            'Sources',
            'PyricIosFirestoreOracle',
            'FirestoreWave5QueriesCollectionGroupAndTxProbes.swift',
          ),
          join(FIRESTORE_SIM_DIR, 'Tests', 'FirestoreOracleSimTests', 'FirestoreOracleSimTests.swift'),
        ];
        const parsed = await runSingleProcessSwiftParse(swiftParser, swiftFiles);
        expect(parsed.exitCode, parsed.output).toBe(0);
      }
    },
    90_000,
  );

  it('deploys and restores scoped collectionGroup Firestore rules and forwards needsCollectionGroupRule in runIosOracleProbe', async () => {
    const defaultTarget = buildIosFirestoreRulesTarget();
    expect(defaultTarget.marker).toBe('@pyric/oracle');

    expect(() => buildIosFirestoreRulesTarget('invalid/group')).toThrow(/Invalid Firestore oracle collectionGroupId/);

    const cgTarget = buildIosFirestoreRulesTarget('cg_ios_run42');
    expect(cgTarget.marker).toBe('@pyric/oracle/cg:cg_ios_run42');
    expect(cgTarget.freshRules).toContain('match /pyric_oracle/{run}/{anything=**}');
    expect(cgTarget.freshRules).toContain('match /{path=**}/cg_ios_run42/{docId}');

    // Verify OracleRulesSession merges cgTarget even when @pyric/oracle is already in baseline rules, then restores baseline.
    const baselineRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    // @pyric/oracle - existing block',
      '    match /pyric_oracle/{run}/{anything=**} {',
      '      allow read, write: if request.auth != null;',
      '    }',
      '    match /{document=**} {',
      '      allow read, write: if false;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const rulesets = new Map<string, string>([
      ['projects/demo-oracle-project/rulesets/rs-baseline', baselineRules],
    ]);
    let activeRuleset = 'projects/demo-oracle-project/rulesets/rs-baseline';
    let createdCounter = 0;

    const session = new OracleRulesSession({
      projectId: 'demo-oracle-project',
      accessToken: async () => 'synthetic-token',
      sleep: async () => {},
      fetch: async (url, init) => {
        let method = 'GET';
        if (init?.method !== undefined) {
          method = init.method;
        }
        if (url.endsWith('/releases/cloud.firestore') && method === 'GET') {
          return new Response(JSON.stringify({ rulesetName: activeRuleset }), { status: 200 });
        }
        if (url.endsWith('/releases/cloud.firestore') && method === 'PATCH') {
          const parsedBody = JSON.parse(String(init?.body)) as {
            release: { rulesetName: string };
          };
          activeRuleset = parsedBody.release.rulesetName;
          return new Response(JSON.stringify({ name: 'projects/demo-oracle-project/releases/cloud.firestore', rulesetName: activeRuleset }), {
            status: 200,
          });
        }
        if (url.endsWith('/rulesets') && method === 'POST') {
          createdCounter += 1;
          const nextName = `projects/demo-oracle-project/rulesets/rs-cg-${String(createdCounter)}`;
          const parsedBody = JSON.parse(String(init?.body)) as {
            source: { files: Array<{ content: string }> };
          };
          const firstFile = parsedBody.source.files[0];
          let nextContent = '';
          if (firstFile !== undefined) {
            nextContent = firstFile.content;
          }
          rulesets.set(nextName, nextContent);
          return new Response(JSON.stringify({ name: nextName }), { status: 200 });
        }
        for (const [rsName, content] of rulesets.entries()) {
          if (url.endsWith(`/${rsName}`) && method === 'GET') {
            return new Response(
              JSON.stringify({ source: { files: [{ name: 'firestore.rules', content }] } }),
              { status: 200 },
            );
          }
        }
        return new Response('not found', { status: 404 });
      },
    });

    const deployOutcome = await session.deploy(cgTarget);
    expect(deployOutcome).toBe('merged');
    expect(rulesets.get(activeRuleset)).toContain('match /{path=**}/cg_ios_run42/{docId}');
    await session.restoreAll();
    expect(activeRuleset).toBe('projects/demo-oracle-project/rulesets/rs-baseline');

    let observedSessionOptions: IosFirestoreSessionOptions | undefined;
    let deployedRunId = '';
    const deletedUids: string[] = [];
    const mockAdmin: IosAdminAuthAdapter = {
      createCustomToken: async (uid) => `jwt-${uid}`,
      deleteUser: async (uid) => {
        deletedUids.push(uid);
      },
      dispose: async () => {},
    };

    const behavior = await runIosOracleProbe({
      probeId: 'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
      mode: 'ios-sim-firestore',
      needsCollectionGroupRule: true,
      deps: {
        platform: 'darwin',
        env: {},
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:444:ios:fswave5',
          messagingSenderId: '444',
        }),
        openAdminAuth: async () => mockAdmin,
        queryAvailableSimulatorsJson: () =>
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                { udid: 'SIM-FS-WAVE5', name: 'iPhone 17', state: 'Booted', isAvailable: true },
              ],
            },
          }),
        deployScopedFirestoreSession: async (_sa, runId, fn, opts) => {
          deployedRunId = runId;
          observedSessionOptions = opts;
          return fn();
        },
        executeFirestoreSim: () => {
          const encoded = Buffer.from(
            JSON.stringify({
              collectionGroupDocIds: ['item_a', 'item_b'],
              retryAttemptsOnSingleConflict: 2,
            }),
            'utf8',
          ).toString('base64');
          return `PYRIC_IOS_ORACLE_RESULT_B64:${encoded}`;
        },
      },
    });

    expect(observedSessionOptions).toEqual({ collectionGroupId: `cg_${deployedRunId}` });
    expect(behavior).toEqual({
      collectionGroupDocIds: ['item_a', 'item_b'],
      retryAttemptsOnSingleConflict: 2,
    });
    expect(deletedUids).toEqual([`pyric-ios-${deployedRunId}`]);

    const baseCiEnv = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      CAPTURE_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
    };
    const stagedTargets = WAVE5_FIRESTORE_PROBE_IDS.map((name) => ({
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
      WAVE5_FIRESTORE_PROBE_IDS.map((name) => ['--write', '--probe', name]),
    );
  });
});
