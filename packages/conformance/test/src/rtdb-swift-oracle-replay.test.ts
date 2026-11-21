import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { probe as dedicatedCrudProbe } from '../../probes/rtdb-swift/rtdb-swift-dedicated-crud-and-query-order.ts';
import { probe as liveWave4Probe } from '../../probes/rtdb-swift/rtdb-swift-listeners-transactions-connection-and-ondisconnect.ts';
import { probe as navWave4Probe } from '../../probes/rtdb-swift/rtdb-swift-navigation-push-priorities-and-snapshots.ts';
import { probe as queriesPermProbe } from '../../probes/rtdb-swift/rtdb-swift-queries-ranges-limits-and-permission-denied.ts';
import { probe as writesTxProbe } from '../../probes/rtdb-swift/rtdb-swift-writes-autoid-servervalue-and-transactions.ts';
import { buildIosRtdbRunRules } from '../../src/ios-oracle-runtime.ts';
import { loadObservations, REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';
import { DEDICATED_INSTANCE, extractRtdbSnap } from './rtdb-kotlin-wave4-oracle-replay-harness.ts';

interface RtdbSwiftDedicatedCrudObservation {
  betaExists: boolean;
  betaIncrementedScore: number;
  betaKey: string;
  betaLabel: string;
  orderedKeys: string[];
  orderedLimitedCount: number;
  orderedScores: number[];
  removedExistsAfterCleanup: boolean;
  sdkVersionPresent: boolean;
}

interface RtdbSwiftWritesAutoIdServerValueTxObservation {
  autoIdAllLength20: boolean;
  autoIdCount: number;
  autoIdOrderedSeqs: number[];
  autoIdStrictlyMonotonic: boolean;
  autoIdUnique: boolean;
  cleanupRemovedRunNode: boolean;
  removedChildExists: boolean;
  serverIncrementFinalHits: number;
  serverTimestampIsNumber: boolean;
  serverTimestampPlausibleEpochMs: boolean;
  txAbortCommitted: boolean;
  txAbortSnapshotValue: number;
  txCommitCommitted: boolean;
  txCommitSnapshotValue: number;
  txPersistedAfterAbort: number;
  txPersistedAfterCommit: number;
  updatedNamePreserved: string;
  updatedRole: string;
  updatedTeamAdded: string;
}

const RTDB_SWIFT_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'rtdb-swift',
);

const SWIFT_DATABASE_SOURCE_DIR = join(
  REPO_ROOT,
  'packages',
  'swift-client',
  'Sources',
  'PyricDatabase',
);

const COVERED_STEMS = new Set([
  'rtdb-swift-dedicated-crud-and-query-order.json',
  'rtdb-swift-writes-autoid-servervalue-and-transactions.json',
]);

const gate = createObservationGate({
  dir: RTDB_SWIFT_OBSERVATIONS_DIR,
  match: (filename) => COVERED_STEMS.has(filename),
});

async function openDedicatedSwiftRtdbBridge(projectId: string, runId: string, uid: string) {
  const defaultRules = { rules: { '.read': false, '.write': false } };
  const dedicatedRules = {
    rules: {
      pyric_oracle: {
        [runId]: buildIosRtdbRunRules(),
      },
    },
  };
  const harness = await openHostedKotlinBridge({
    projectId,
    permissive: false,
    databaseRules: defaultRules,
    databaseRulesByInstance: {
      [`${projectId}-default-rtdb`]: defaultRules,
      [DEDICATED_INSTANCE]: dedicatedRules,
    },
  });
  try {
    const customToken = mintCustomToken({ uid, projectId, nowMs: Date.now() });
    const signInRes = await harness.sendOp({ method: 'auth.signInWithCustomToken', customToken });
    if (!signInRes.ok) {
      throw new Error(`Custom token sign-in failed: ${JSON.stringify(signInRes.error)}`);
    }
    return { harness, actAs: { mode: 'as' as const, uid } };
  } catch (err) {
    await harness.close();
    throw err;
  }
}

describe('rtdb-swift dedicated CRUD, auto-ID, ServerValue, and transaction observation replay', () => {
  test('replays dedicated-instance setValue, updateChildValues + ServerValue.increment, queryOrdered(byChild:) + queryLimited(toFirst:), and removeValue', async () => {
    const obs = gate.load<RtdbSwiftDedicatedCrudObservation>(
      'rtdb-swift-dedicated-crud-and-query-order',
    );
    expect(obs.sdkVersionPresent).toBe(true);

    const serverValueSwift = readFileSync(
      join(SWIFT_DATABASE_SOURCE_DIR, 'ServerValue.swift'),
      'utf8',
    );
    expect(serverValueSwift).toContain('return [".sv": ["increment": delta.int64Value]]');

    const runId = 'replay_ios_rtdb_crud_1';
    const { harness, actAs } = await openDedicatedSwiftRtdbBridge(
      `demo-ios-rtdb-crud-${Date.now()}`,
      runId,
      'ios-rtdb-crud-uid',
    );

    try {
      const runPath = `pyric_oracle/${runId}`;
      const itemsPath = `${runPath}/items`;

      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${itemsPath}/alpha`,
        value: { label: 'Alpha', score: 20 },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${itemsPath}/beta`,
        value: { label: 'Beta', score: 5 },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${itemsPath}/gamma`,
        value: { label: 'Gamma', score: 12 },
        actAs,
      });

      const defaultCheck = await harness.sendOp({
        method: 'rtdb.get',
        path: `${itemsPath}/beta`,
        actAs,
      });
      expect(defaultCheck.ok).toBe(false);

      const updateRes = await harness.sendOp({
        method: 'rtdb.update',
        instance: DEDICATED_INSTANCE,
        path: `${itemsPath}/beta`,
        values: { score: { '.sv': { increment: 5 } } },
        actAs,
      });
      expect(updateRes.ok).toBe(true);

      const betaSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: `${itemsPath}/beta`,
          actAs,
        }),
      );
      const betaMap = betaSnap.value as Record<string, unknown>;
      expect(betaSnap.exists).toBe(obs.betaExists);
      expect(betaSnap.key).toBe(obs.betaKey);
      expect(betaMap.label).toBe(obs.betaLabel);
      expect(betaMap.score).toBe(obs.betaIncrementedScore);

      const orderedSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: itemsPath,
          query: {
            orderBy: { kind: 'child', path: 'score' },
            bounds: [],
            limit: { kind: 'limitToFirst', n: 2 },
          },
          actAs,
        }),
      );
      expect(orderedSnap.size).toBe(obs.orderedLimitedCount);
      expect(orderedSnap.entries.map((entry) => entry.key)).toEqual(obs.orderedKeys);
      expect(
        orderedSnap.entries.map((entry) => (entry.value as Record<string, unknown>).score),
      ).toEqual(obs.orderedScores);

      const removeRes = await harness.sendOp({
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: runPath,
        actAs,
      });
      expect(removeRes.ok).toBe(true);

      const removedSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: runPath, actAs }),
      );
      expect(removedSnap.exists).toBe(obs.removedExistsAfterCleanup);
    } finally {
      await harness.close();
    }
  });

  test('replays updateChildValues partial merge, childByAutoId monotonic push keys, ServerValue sentinels, and runTransactionBlock commit/abort', async () => {
    const obs = gate.load<RtdbSwiftWritesAutoIdServerValueTxObservation>(
      'rtdb-swift-writes-autoid-servervalue-and-transactions',
    );
    const pushSwift = readFileSync(
      join(SWIFT_DATABASE_SOURCE_DIR, 'PushIdGenerator.swift'),
      'utf8',
    );
    const refSwift = readFileSync(
      join(SWIFT_DATABASE_SOURCE_DIR, 'DatabaseReference.swift'),
      'utf8',
    );
    expect(pushSwift).toContain('public static func generatePushId() -> String');
    expect(refSwift).toContain('if txResult.isAborted {');
    expect(refSwift).toContain('return (committed: false, snapshot: currentSnap)');

    const runId = 'replay_ios_rtdb_writes_1';
    const { harness, actAs } = await openDedicatedSwiftRtdbBridge(
      `demo-ios-rtdb-writes-${Date.now()}`,
      runId,
      'ios-rtdb-writes-uid',
    );

    try {
      const runPath = `pyric_oracle/${runId}`;
      const profilePath = `${runPath}/profile`;

      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: profilePath,
        value: { name: 'Grace', role: 'viewer', legacy: 'drop-me' },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.update',
        instance: DEDICATED_INSTANCE,
        path: profilePath,
        values: { role: 'maintainer', team: 'core' },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: `${profilePath}/legacy`,
        actAs,
      });

      const profileSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: profilePath, actAs }),
      );
      const profileMap = profileSnap.value as Record<string, unknown>;
      expect(profileMap.name).toBe(obs.updatedNamePreserved);
      expect(profileMap.role).toBe(obs.updatedRole);
      expect(profileMap.team).toBe(obs.updatedTeamAdded);
      expect('legacy' in profileMap).toBe(obs.removedChildExists);

      const feedPath = `${runPath}/feed`;
      const pushKeys: string[] = [];
      for (const seq of [1, 2, 3]) {
        const pushRes = await harness.sendOp({
          method: 'rtdb.push',
          instance: DEDICATED_INSTANCE,
          path: feedPath,
          value: { seq },
          actAs,
        });
        expect(pushRes.ok).toBe(true);
        const pushVal = pushRes.value as { key: string };
        pushKeys.push(pushVal.key);
      }
      const k1 = String(pushKeys[0]);
      const k2 = String(pushKeys[1]);
      const k3 = String(pushKeys[2]);
      expect(pushKeys.length).toBe(obs.autoIdCount);
      expect(k1.length === 20 && k2.length === 20 && k3.length === 20).toBe(obs.autoIdAllLength20);
      expect(new Set(pushKeys).size === 3).toBe(obs.autoIdUnique);
      expect(k1 < k2 && k2 < k3).toBe(obs.autoIdStrictlyMonotonic);

      const orderedFeed = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: feedPath,
          query: { orderBy: { kind: 'key' }, bounds: [], limit: null },
          actAs,
        }),
      );
      expect(
        orderedFeed.entries.map((entry) => (entry.value as Record<string, unknown>).seq),
      ).toEqual(obs.autoIdOrderedSeqs);

      const metricsPath = `${runPath}/metrics`;
      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: metricsPath,
        value: { hits: 10, updatedAt: { '.sv': 'timestamp' } },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.update',
        instance: DEDICATED_INSTANCE,
        path: metricsPath,
        values: { hits: { '.sv': { increment: 7 } } },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.update',
        instance: DEDICATED_INSTANCE,
        path: metricsPath,
        values: { hits: { '.sv': { increment: -2 } } },
        actAs,
      });

      const metricsSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: metricsPath, actAs }),
      );
      const metricsMap = metricsSnap.value as Record<string, unknown>;
      expect(metricsMap.hits).toBe(obs.serverIncrementFinalHits);
      expect(typeof metricsMap.updatedAt === 'number').toBe(obs.serverTimestampIsNumber);
      const tsEpoch = Number(metricsMap.updatedAt);
      expect(tsEpoch >= 1_700_000_000_000 && tsEpoch < 4_102_444_800_000).toBe(
        obs.serverTimestampPlausibleEpochMs,
      );

      const counterPath = `${runPath}/tx_counter`;
      await harness.sendOp({ method: 'rtdb.set', instance: DEDICATED_INSTANCE, path: counterPath, value: 10, actAs });

      const txRead1 = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: counterPath,
          transaction: true,
          actAs,
        }),
      );
      const txCommitRes = await harness.sendOp({
        method: 'rtdb.transactionCommit',
        instance: DEDICATED_INSTANCE,
        path: counterPath,
        expected: txRead1.value,
        value: Number(txRead1.value) + 15,
        applyLocally: true,
        actAs,
      });
      expect(txCommitRes.ok).toBe(true);
      const txCommitWire = txCommitRes.value as { committed: boolean; snapshot: { value: number } };
      expect(txCommitWire.committed).toBe(obs.txCommitCommitted);
      expect(txCommitWire.snapshot.value).toBe(obs.txCommitSnapshotValue);

      const afterCommitSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: counterPath, actAs }),
      );
      expect(afterCommitSnap.value).toBe(obs.txPersistedAfterCommit);

      const txAbortRead = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: counterPath,
          transaction: true,
          actAs,
        }),
      );
      expect(obs.txAbortCommitted).toBe(false);
      expect(txAbortRead.value).toBe(obs.txAbortSnapshotValue);

      const afterAbortSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: counterPath, actAs }),
      );
      expect(afterAbortSnap.value).toBe(obs.txPersistedAfterAbort);

      await harness.sendOp({ method: 'rtdb.remove', instance: DEDICATED_INSTANCE, path: runPath, actAs });
      const removedRunSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: runPath, actAs }),
      );
      expect(!removedRunSnap.exists).toBe(obs.cleanupRemovedRunNode);
    } finally {
      await harness.close();
    }
  });

  test('covers committed CRUD and writes captures via createObservationGate and verifies all 5 linked descriptors', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'rtdb-swift-dedicated-crud-and-query-order',
      'rtdb-swift-writes-autoid-servervalue-and-transactions',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);

    const rtdbObs = loadObservations().filter((item) => item.surfaceDir === 'rtdb-swift');
    expect(rtdbObs.length).toBe(5);
    for (const item of rtdbObs) {
      expect(item.iosSdkVersion).toBe('13.2.0');
      expect(item.matrixRow.startsWith('rtdb-swift#')).toBe(true);
      expect(item.rowIds.length).toBeGreaterThan(0);
    }

    expect(dedicatedCrudProbe.pendingRowLink).toBeUndefined();
    expect(dedicatedCrudProbe.rowIds.length).toBe(13);
    expect(writesTxProbe.pendingRowLink).toBeUndefined();
    expect(writesTxProbe.rowIds.length).toBe(9);
    expect(queriesPermProbe.pendingRowLink).toBeUndefined();
    expect(queriesPermProbe.rowIds.length).toBe(8);
    expect(navWave4Probe.pendingRowLink).toBeUndefined();
    expect(navWave4Probe.rowIds.length).toBe(20);
    expect(liveWave4Probe.pendingRowLink).toBeUndefined();
    expect(liveWave4Probe.rowIds.length).toBe(12);
  });
});
