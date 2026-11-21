import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';

interface RtdbKotlinDedicatedCrudAndQueryOrderObservation {
  existsAfterWrite: boolean;
  keyMatches: boolean;
  childrenCount: number;
  incrementedCount: number;
  integerValueClass: string;
  extraField: string;
  orderedLimitToFirstKeys: string[];
  existsAfterRemove: boolean;
}

const RTDB_KOTLIN_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'rtdb-kotlin',
);

const KT_DATA_SNAPSHOT_PATH = join(
  REPO_ROOT,
  'packages',
  'kt-client',
  'src',
  'main',
  'kotlin',
  'com',
  'google',
  'firebase',
  'database',
  'DataSnapshot.kt',
);

const KT_LIVE_ORACLE_PARITY_TEST_PATH = join(
  REPO_ROOT,
  'packages',
  'kt-client',
  'src',
  'test',
  'kotlin',
  'dev',
  'pyric',
  'e2e',
  'OracleParityLiveHostConformanceTest.kt',
);

const DEDICATED_INSTANCE = 'pyric-oracle-rtdb-2';

const gate = createObservationGate({
  dir: RTDB_KOTLIN_OBSERVATIONS_DIR,
  match: (filename) => filename === 'rtdb-kotlin-dedicated-crud-and-query-order.json',
});

describe('rtdb-kotlin Android SDK production observation replay over hosted worker bridge', () => {
  test('replays dedicated-instance setValue, updateChildren + ServerValue.increment, orderByChild + limitToFirst, and removeValue RPCs', async () => {
    const obs = gate.load<RtdbKotlinDedicatedCrudAndQueryOrderObservation>(
      'rtdb-kotlin-dedicated-crud-and-query-order',
    );
    const projectId = `demo-kt-rtdb-${Date.now()}`;
    const runId = 'replay_run_1';
    const dedicatedRules = {
      rules: {
        pyric_oracle: {
          [runId]: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            rtdb_kotlin: {
              catalog: {
                '.indexOn': ['score'],
              },
            },
          },
        },
      },
    };
    const defaultRules = {
      rules: {
        '.read': false,
        '.write': false,
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
      const uid = 'android-rtdb-replay-uid';
      const customToken = mintCustomToken({
        uid,
        claims: { role: 'tester', tier: 2 },
        projectId,
        nowMs: Date.now(),
      });
      const signInRes = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken,
      });
      expect(signInRes.ok).toBe(true);

      const actAs = { mode: 'as', uid };
      const basePath = `pyric_oracle/${runId}/rtdb_kotlin`;
      const itemPath = `${basePath}/counter_doc`;

      const setRes = await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: itemPath,
        value: { label: 'alpha', count: 10 },
        actAs,
      });
      expect(setRes.ok).toBe(true);

      const defaultInstanceCheck = await harness.sendOp({
        method: 'rtdb.get',
        path: itemPath,
        actAs,
      });
      expect(defaultInstanceCheck.ok).toBe(false);

      const updateRes = await harness.sendOp({
        method: 'rtdb.update',
        instance: DEDICATED_INSTANCE,
        path: itemPath,
        values: {
          count: { '.sv': { increment: 5 } },
          extra: 'kept',
        },
        actAs,
      });
      expect(updateRes.ok).toBe(true);

      const getAfterUpdate = await harness.sendOp({
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: itemPath,
        actAs,
      });
      expect(getAfterUpdate.ok).toBe(true);
      const snapWire = getAfterUpdate.value as {
        exists: boolean;
        key: string;
        value: Record<string, unknown>;
      };
      expect(snapWire.exists).toBe(obs.existsAfterWrite);
      expect(itemPath.endsWith('/counter_doc')).toBe(obs.keyMatches);
      expect(Object.keys(snapWire.value).length).toBe(obs.childrenCount);
      expect(snapWire.value.count).toBe(obs.incrementedCount);
      expect(snapWire.value.extra).toBe(obs.extraField);

      expect(obs.integerValueClass).toBe('java.lang.Long');
      expect(Number.isInteger(snapWire.value.count)).toBe(true);
      const dataSnapshotSource = readFileSync(KT_DATA_SNAPSHOT_PATH, 'utf8');
      expect(dataSnapshotSource).toContain('internal fun normalizeRtdbValue(raw: Any?): Any?');
      expect(dataSnapshotSource).toContain('is Int -> raw.toLong()');
      expect(dataSnapshotSource).toContain('value = normalizeRtdbValue(value)');
      const liveParitySuiteSource = readFileSync(KT_LIVE_ORACLE_PARITY_TEST_PATH, 'utf8');
      expect(liveParitySuiteSource).toContain(
        'assertEquals("java.lang.Long", countVal!!::class.java.name)',
      );

      const catalogPath = `${basePath}/catalog`;
      const catalogSetRes = await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: catalogPath,
        value: {
          c: { score: 30 },
          a: { score: 10 },
          b: { score: 20 },
        },
        actAs,
      });
      expect(catalogSetRes.ok).toBe(true);

      const queryRes = await harness.sendOp({
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: catalogPath,
        query: {
          orderBy: { kind: 'child', path: 'score' },
          bounds: [],
          limit: { kind: 'limitToFirst', n: 2 },
        },
        actAs,
      });
      expect(queryRes.ok).toBe(true);
      const queryWire = queryRes.value as {
        entries: Array<{ key: string; value: unknown }>;
      };
      expect(queryWire.entries.map((entry) => entry.key)).toEqual(obs.orderedLimitToFirstKeys);

      const removeRes = await harness.sendOp({
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: itemPath,
        actAs,
      });
      expect(removeRes.ok).toBe(true);

      const afterRemoveRes = await harness.sendOp({
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: itemPath,
        actAs,
      });
      expect(afterRemoveRes.ok).toBe(true);
      const afterRemoveWire = afterRemoveRes.value as { exists: boolean };
      expect(afterRemoveWire.exists).toBe(obs.existsAfterRemove);
    } finally {
      await harness.close();
    }
  });

  test('covers every committed non-staged rtdb-kotlin observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual(['rtdb-kotlin-dedicated-crud-and-query-order']);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
