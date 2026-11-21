import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { buildIosRtdbPermissionAndQueryRules } from '../../src/ios-oracle-runtime.ts';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';
import {
  DEDICATED_INSTANCE,
  extractEntryKeys,
  extractRtdbSnap,
} from './rtdb-kotlin-wave4-oracle-replay-harness.ts';

interface RtdbSwiftQueriesRangesLimitsDeniedObservation {
  cleanupRemovedWorkspaceNode: boolean;
  getDataDeniedCode: number;
  getDataDeniedDomain: string;
  getDataDeniedHasPermissionText: boolean;
  getDataDeniedRejected: boolean;
  keyAllKeys: string[];
  keyLimitToFirstKeys: string[];
  keyLimitToLastKeys: string[];
  keyRangeKeys: string[];
  keyRangeValues: string[];
  observeDeniedCode: number;
  observeDeniedDomain: string;
  observeDeniedHasPermissionText: boolean;
  observeDeniedRejected: boolean;
  valueEqualKeys: string[];
  valueEqualScores: number[];
  valueLimitToLastKeys: string[];
  valueLimitToLastScores: number[];
  valueRangeKeys: string[];
  valueRangeScores: number[];
  writeDeniedCode: number;
  writeDeniedDomain: string;
  writeDeniedHasPermissionText: boolean;
  writeDeniedRejected: boolean;
}

const RTDB_SWIFT_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'rtdb-swift',
);

const gate = createObservationGate({
  dir: RTDB_SWIFT_OBSERVATIONS_DIR,
  match: (filename) => filename === 'rtdb-swift-queries-ranges-limits-and-permission-denied.json',
});

function hasPermissionDeniedSignal(code: string | undefined, message: string | undefined): boolean {
  let normalizedCode = '';
  if (typeof code === 'string') {
    normalizedCode = code.toLowerCase();
  }
  let normalizedMessage = '';
  if (typeof message === 'string') {
    normalizedMessage = message.toLowerCase();
  }
  return (
    normalizedCode === 'permission-denied' ||
    normalizedCode === 'permission_denied' ||
    normalizedMessage.includes('permission_denied') ||
    normalizedMessage.includes('permission denied')
  );
}

describe('rtdb-swift Wave 2 queries, ranges, limits, and permission-denied observation replay', () => {
  test('replays queryOrderedByKey, queryOrderedByValue, ranges, limits, and permission-denied rejections', async () => {
    const obs = gate.load<RtdbSwiftQueriesRangesLimitsDeniedObservation>(
      'rtdb-swift-queries-ranges-limits-and-permission-denied',
    );
    expect(obs.writeDeniedDomain).toBe('com.firebase');
    expect(obs.writeDeniedCode).toBe(1);
    expect(obs.observeDeniedDomain).toBe('com.firebase');
    expect(obs.observeDeniedCode).toBe(1);
    expect(obs.getDataDeniedDomain).toBe('com.firebase.core');
    expect(obs.getDataDeniedCode).toBe(1);

    const projectId = `demo-ios-rtdb-queries-${Date.now()}`;
    const runId = 'replay_ios_rtdb_queries_1';
    const uid = 'ios-rtdb-queries-uid';
    const defaultRules = { rules: { '.read': false, '.write': false } };
    const dedicatedRules = {
      rules: {
        pyric_oracle: {
          [runId]: buildIosRtdbPermissionAndQueryRules(),
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
      expect(signInRes.ok).toBe(true);
      const actAs = { mode: 'as' as const, uid };

      const workspacePath = `pyric_oracle/${runId}/workspace`;
      const byKeyPath = `${workspacePath}/by_key`;
      const scoresPath = `${workspacePath}/scores`;
      const deniedPath = `pyric_oracle/${runId}/denied_leaf`;

      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: byKeyPath,
        value: { k1: 'one', k2: 'two', k3: 'three', k4: 'four' },
        actAs,
      });

      expect(
        extractEntryKeys(
          await harness.sendOp({
            method: 'rtdb.get',
            instance: DEDICATED_INSTANCE,
            path: byKeyPath,
            query: { orderBy: { kind: 'key' }, bounds: [], limit: null },
            actAs,
          }),
        ),
      ).toEqual(obs.keyAllKeys);

      expect(
        extractEntryKeys(
          await harness.sendOp({
            method: 'rtdb.get',
            instance: DEDICATED_INSTANCE,
            path: byKeyPath,
            query: { orderBy: { kind: 'key' }, bounds: [], limit: { kind: 'limitToFirst', n: 2 } },
            actAs,
          }),
        ),
      ).toEqual(obs.keyLimitToFirstKeys);

      expect(
        extractEntryKeys(
          await harness.sendOp({
            method: 'rtdb.get',
            instance: DEDICATED_INSTANCE,
            path: byKeyPath,
            query: { orderBy: { kind: 'key' }, bounds: [], limit: { kind: 'limitToLast', n: 2 } },
            actAs,
          }),
        ),
      ).toEqual(obs.keyLimitToLastKeys);

      const keyRangeSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: byKeyPath,
          query: {
            orderBy: { kind: 'key' },
            bounds: [
              { kind: 'startAt', value: 'k2' },
              { kind: 'endAt', value: 'k3' },
            ],
            limit: null,
          },
          actAs,
        }),
      );
      expect(keyRangeSnap.entries.map((entry) => entry.key)).toEqual(obs.keyRangeKeys);
      expect(keyRangeSnap.entries.map((entry) => entry.value)).toEqual(obs.keyRangeValues);

      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: scoresPath,
        value: { p1: 10, p2: 20, p3: 20, p4: 35, p5: 50 },
        actAs,
      });

      const valueEqualSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: scoresPath,
          query: { orderBy: { kind: 'value' }, bounds: [{ kind: 'equalTo', value: 20 }], limit: null },
          actAs,
        }),
      );
      expect(valueEqualSnap.entries.map((entry) => entry.key)).toEqual(obs.valueEqualKeys);
      expect(valueEqualSnap.entries.map((entry) => entry.value)).toEqual(obs.valueEqualScores);

      const valueRangeSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: scoresPath,
          query: {
            orderBy: { kind: 'value' },
            bounds: [
              { kind: 'startAt', value: 20 },
              { kind: 'endAt', value: 35 },
            ],
            limit: null,
          },
          actAs,
        }),
      );
      expect(valueRangeSnap.entries.map((entry) => entry.key)).toEqual(obs.valueRangeKeys);
      expect(valueRangeSnap.entries.map((entry) => entry.value)).toEqual(obs.valueRangeScores);

      const valueLimitLastSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: scoresPath,
          query: { orderBy: { kind: 'value' }, bounds: [], limit: { kind: 'limitToLast', n: 2 } },
          actAs,
        }),
      );
      expect(valueLimitLastSnap.entries.map((entry) => entry.key)).toEqual(obs.valueLimitToLastKeys);
      expect(valueLimitLastSnap.entries.map((entry) => entry.value)).toEqual(
        obs.valueLimitToLastScores,
      );

      const writeDeniedRes = await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${deniedPath}/write_attempt`,
        value: { blocked: true },
        actAs,
      });
      expect(!writeDeniedRes.ok).toBe(obs.writeDeniedRejected);
      expect(
        hasPermissionDeniedSignal(writeDeniedRes.error?.code, writeDeniedRes.error?.message),
      ).toBe(obs.writeDeniedHasPermissionText);

      const getDataDeniedRes = await harness.sendOp({
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: `${deniedPath}/getdata_attempt`,
        actAs,
      });
      expect(!getDataDeniedRes.ok).toBe(obs.getDataDeniedRejected);
      expect(
        hasPermissionDeniedSignal(getDataDeniedRes.error?.code, getDataDeniedRes.error?.message),
      ).toBe(obs.getDataDeniedHasPermissionText);

      const subDeniedPromise = new Promise<{ code?: string; message?: string }>(
        (resolveDenied, rejectDenied) => {
          const timer = setTimeout(() => {
            rejectDenied(new Error('Timed out waiting for denied RTDB subscription error'));
          }, 5_000);
          harness.subscribe(
            'rsub-ios-denied-1',
            {
              target: {
                service: 'rtdb',
                instance: DEDICATED_INSTANCE,
                path: `${deniedPath}/listen_attempt`,
              },
              actAs,
            },
            (rawVal) => {
              clearTimeout(timer);
              const errWrapper = rawVal as { __error?: { code?: string; message?: string } };
              let extracted: { code?: string; message?: string } = {};
              if (errWrapper.__error !== undefined) {
                extracted = errWrapper.__error;
              }
              resolveDenied(extracted);
            },
          );
        },
      );
      try {
        const subErr = await subDeniedPromise;
        expect(subErr.code !== undefined || subErr.message !== undefined).toBe(
          obs.observeDeniedRejected,
        );
        expect(hasPermissionDeniedSignal(subErr.code, subErr.message)).toBe(
          obs.observeDeniedHasPermissionText,
        );
      } finally {
        harness.unsubscribe('rsub-ios-denied-1');
      }

      await harness.sendOp({
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: workspacePath,
        actAs,
      });
      const cleanedSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: workspacePath,
          actAs,
        }),
      );
      expect(!cleanedSnap.exists).toBe(obs.cleanupRemovedWorkspaceNode);
    } finally {
      await harness.close();
    }
  });

  test('covers rtdb-swift-queries-ranges-limits-and-permission-denied through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual(['rtdb-swift-queries-ranges-limits-and-permission-denied']);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
