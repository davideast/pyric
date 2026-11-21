import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAndroidRtdbPermissionAndQueryRules } from '../../src/android-oracle-runtime.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { verifyWave4ListenersTransactionsAndOnDisconnect } from './rtdb-kotlin-wave4-live-scenarios.ts';
import {
  DEDICATED_INSTANCE,
  extractEntryKeys,
  extractRtdbSnap,
  KT_MAIN_ROOT,
  openAuthenticatedDedicatedRtdbBridge,
  RTDB_KOTLIN_OBSERVATIONS_DIR,
  type RtdbKotlinListenersTxConnectionOnDisconnectObservation,
  type RtdbKotlinNavPushPrioritiesSnapshotsObservation,
  type RtdbKotlinQueriesRangesLimitsDeniedObservation,
} from './rtdb-kotlin-wave4-oracle-replay-harness.ts';

const gate = createObservationGate({
  dir: RTDB_KOTLIN_OBSERVATIONS_DIR,
  match: (filename) =>
    filename.startsWith('rtdb-kotlin-') &&
    filename !== 'rtdb-kotlin-dedicated-crud-and-query-order.json',
});

describe('rtdb-kotlin Wave 4 Android SDK production observation replay over hosted worker bridge', () => {
  test('replays instance/reference navigation, push() monotonic keys, ServerValue.TIMESTAMP, priorities, and setValue(null)', async () => {
    const obs = gate.load<RtdbKotlinNavPushPrioritiesSnapshotsObservation>(
      'rtdb-kotlin-navigation-push-priorities-and-snapshots',
    );
    const dbKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'FirebaseDatabase.kt'),
      'utf8',
    );
    const dbKtxKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'Database.kt'),
      'utf8',
    );
    const refKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'DatabaseReference.kt'),
      'utf8',
    );
    const pushKt = readFileSync(
      join(KT_MAIN_ROOT, 'dev', 'pyric', 'database', 'internal', 'PushIdGenerator.kt'),
      'utf8',
    );
    const snapKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'DataSnapshot.kt'),
      'utf8',
    );

    expect(dbKtxKt).toContain('get() = FirebaseDatabase.getInstance()');
    expect(obs.defaultInstanceMatchesFirebaseKtx).toBe(true);
    expect(obs.namedDatabaseMatchesFirebaseKtx).toBe(true);
    expect(dbKt).toContain('get() = DatabaseReference(this, "")');
    expect(refKt).toContain('if (trimmed.isEmpty()) return null');
    expect(refKt).toContain('get() = DatabaseReference(database, "")');
    expect(refKt).toContain('if (path.isEmpty()) cleanUrl else "$cleanUrl/$path"');
    expect(obs.defaultRootMatchesUrl).toBe(true);
    expect(obs.rootKeyIsNull).toBe(true);
    expect(obs.rootParentIsNull).toBe(true);
    expect(obs.rootSelfEqualsRoot).toBe(true);
    expect(obs.nestedKey).toBe('leaf_node');
    expect(obs.nestedParentKey).toBe('section');
    expect(obs.nestedGrandParentKey).toBe('nav');
    expect(obs.nestedRootKeyIsNull).toBe(true);
    expect(obs.nestedRootMatchesDatabaseRoot).toBe(true);
    expect(obs.normalizedRelativePathSuffixMatches).toBe(true);
    expect(pushKt).toContain('val id = StringBuilder(20)');
    expect(snapKt).toContain('is Int -> raw.toLong()');
    expect(obs.integralValueClass).toBe('java.lang.Long');
    expect(obs.stringValueClass).toBe('java.lang.String');
    expect(obs.floatingValueClass).toBe('java.lang.Double');
    expect(obs.booleanValueClass).toBe('java.lang.Boolean');
    expect(obs.listValueClass).toBe('java.util.ArrayList');
    expect(obs.mapValueClass).toBe('java.util.HashMap');

    const runId = 'replay_rtdb_nav_1';
    const { harness, actAs } = await openAuthenticatedDedicatedRtdbBridge(
      `demo-kt-rtdb-nav-${Date.now()}`,
      runId,
      'android-rtdb-nav-uid',
      {
        rtdb_kotlin: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    );

    try {
      const basePath = `pyric_oracle/${runId}/rtdb_kotlin`;
      const pushGroupPath = `${basePath}/pushed_items`;

      const pushKeys: string[] = [];
      for (const label of ['first', 'second', 'third']) {
        const pushRes = await harness.sendOp({
          method: 'rtdb.push',
          instance: DEDICATED_INSTANCE,
          path: pushGroupPath,
          value: label,
          actAs,
        });
        expect(pushRes.ok).toBe(true);
        const pushVal = pushRes.value as { key: string; path: string };
        pushKeys.push(pushVal.key);
      }
      expect(pushKeys[0]?.length).toBe(obs.pushKeyLength);
      const isMonotonic =
        (pushKeys[0] as string) < (pushKeys[1] as string) &&
        (pushKeys[1] as string) < (pushKeys[2] as string);
      expect(isMonotonic).toBe(obs.pushKeysLexicographicallyMonotonic);

      const pushOrderedSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: pushGroupPath,
          query: { orderBy: { kind: 'key' }, bounds: [], limit: null },
          actAs,
        }),
      );
      expect(pushOrderedSnap.entries.map((e) => e.value)).toEqual(obs.pushOrderedValues);

      const typesPath = `${basePath}/value_types`;
      const setTypesRes = await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: typesPath,
        value: {
          str: 'hello-rtdb',
          whole: 42,
          frac: 3.5,
          flag: true,
          list: ['x', 'y'],
          nested: { inner: 7 },
          stampedAt: { '.sv': 'timestamp' },
        },
        actAs,
      });
      expect(setTypesRes.ok).toBe(true);

      const typesSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: typesPath,
          actAs,
        }),
      );
      const typesMap = typesSnap.value as Record<string, unknown>;
      expect(typesMap.whole === 42).toBe(obs.integralValueEquals42);
      expect('nested' in typesMap).toBe(obs.hasChildNested);
      expect('nonexistent' in typesMap).toBe(obs.hasChildMissing);
      expect(typesSnap.size > 0).toBe(obs.hasChildrenTrue);
      expect(obs.serverTimestampValueClass).toBe('java.lang.Long');
      expect((typesMap.stampedAt as number) > 1_700_000_000_000).toBe(
        obs.serverTimestampEpochPlausible,
      );

      const missingSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: `${basePath}/missing_leaf`,
          actAs,
        }),
      );
      expect(missingSnap.exists).toBe(obs.missingSnapshotExists);
      expect(missingSnap.value === null).toBe(obs.missingSnapshotValueIsNull);
      expect(missingSnap.size > 0).toBe(obs.missingSnapshotHasChildren);

      const prioPath = `${basePath}/priority_items`;
      const pSecondPath = `${prioPath}/item_second`;
      const pFirstPath = `${prioPath}/item_first`;
      const pThirdPath = `${prioPath}/item_third`;

      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: pSecondPath,
        value: 'second-by-set-priority',
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.setPriority',
        instance: DEDICATED_INSTANCE,
        path: pSecondPath,
        priority: 20.0,
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.setWithPriority',
        instance: DEDICATED_INSTANCE,
        path: pFirstPath,
        value: 'first-with-priority',
        priority: 5.0,
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.setWithPriority',
        instance: DEDICATED_INSTANCE,
        path: pThirdPath,
        value: 'third-string-priority',
        priority: 'zeta',
        actAs,
      });

      const pSecondSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: pSecondPath, actAs }),
      );
      const pFirstSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: pFirstPath, actAs }),
      );
      const pThirdSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: pThirdPath, actAs }),
      );
      const prioGroupSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: prioPath, actAs }),
      );

      expect(pSecondSnap.value).toBe(obs.setPriorityPreservedValue);
      expect(pSecondSnap.priority).toBe(obs.setPriorityNumericValue);
      expect(obs.setPriorityNumericClass).toBe('java.lang.Double');
      expect(pFirstSnap.priority).toBe(obs.setValueWithNumericPriority);
      expect(pThirdSnap.priority).toBe(obs.setValueWithStringPriority);
      expect(obs.setValueWithStringPriorityClass).toBe('java.lang.String');
      expect(prioGroupSnap.entries.map((e) => e.value)).toEqual(obs.defaultPriorityOrderedValues);

      expect(pThirdSnap.exists).toBe(obs.existedBeforeSetNull);
      const setNullRes = await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: pThirdPath,
        value: null,
        actAs,
      });
      expect(setNullRes.ok).toBe(true);
      const afterNullSnap = extractRtdbSnap(
        await harness.sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: pThirdPath, actAs }),
      );
      expect(afterNullSnap.exists).toBe(obs.existsAfterSetNull);
      expect(afterNullSnap.value === null).toBe(obs.valueNullAfterSetNull);
      expect(afterNullSnap.priority === null).toBe(obs.priorityNullAfterSetNull);
    } finally {
      await harness.close();
    }
  });

  test('replays orderByKey, orderByValue, orderByChild, equalTo(value, key), ranges, limits, and PERMISSION_DENIED', async () => {
    const obs = gate.load<RtdbKotlinQueriesRangesLimitsDeniedObservation>(
      'rtdb-kotlin-queries-ranges-limits-and-permission-denied',
    );
    const dbErrorKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'DatabaseError.kt'),
      'utf8',
    );
    expect(dbErrorKt).toContain('const val PERMISSION_DENIED = -3');

    const runId = 'replay_rtdb_queries_1';
    const { harness, actAs } = await openAuthenticatedDedicatedRtdbBridge(
      `demo-kt-rtdb-queries-${Date.now()}`,
      runId,
      'android-rtdb-queries-uid',
      buildAndroidRtdbPermissionAndQueryRules(),
    );

    try {
      const basePath = `pyric_oracle/${runId}/rtdb_kotlin`;
      const scoresPath = `${basePath}/scores`;
      const playersPath = `${basePath}/players`;

      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: scoresPath,
        value: { c: 40, a: 30, e: 20, b: 10, d: 20 },
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: playersPath,
        value: {
          p1: { tier: 'gold', score: 10 },
          p2: { tier: 'silver', score: 20 },
          p3: { tier: 'gold', score: 30 },
          p4: { tier: 'bronze', score: 40 },
        },
        actAs,
      });

      const queryKeys = (path: string, query: Record<string, unknown>) =>
        harness
          .sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path, query, actAs })
          .then(extractEntryKeys);

      expect(await queryKeys(scoresPath, { orderBy: { kind: 'key' }, bounds: [], limit: null })).toEqual(
        obs.orderByKeyAll,
      );
      expect(
        await queryKeys(scoresPath, {
          orderBy: { kind: 'key' },
          bounds: [
            { kind: 'startAt', value: 'b' },
            { kind: 'endAt', value: 'd' },
          ],
          limit: null,
        }),
      ).toEqual(obs.orderByKeyRangeBToD);
      expect(
        await queryKeys(scoresPath, {
          orderBy: { kind: 'key' },
          bounds: [],
          limit: { kind: 'limitToFirst', n: 2 },
        }),
      ).toEqual(obs.orderByKeyLimitToFirst2);
      expect(
        await queryKeys(scoresPath, {
          orderBy: { kind: 'key' },
          bounds: [],
          limit: { kind: 'limitToLast', n: 2 },
        }),
      ).toEqual(obs.orderByKeyLimitToLast2);

      expect(await queryKeys(scoresPath, { orderBy: { kind: 'value' }, bounds: [], limit: null })).toEqual(
        obs.orderByValueAll,
      );
      expect(
        await queryKeys(scoresPath, {
          orderBy: { kind: 'value' },
          bounds: [{ kind: 'equalTo', value: 20.0 }],
          limit: null,
        }),
      ).toEqual(obs.orderByValueEqualTo20);
      expect(
        await queryKeys(scoresPath, {
          orderBy: { kind: 'value' },
          bounds: [
            { kind: 'startAt', value: 15.0 },
            { kind: 'endAt', value: 35.0 },
          ],
          limit: null,
        }),
      ).toEqual(obs.orderByValueRange15To35);
      expect(
        await queryKeys(scoresPath, {
          orderBy: { kind: 'value' },
          bounds: [],
          limit: { kind: 'limitToLast', n: 2 },
        }),
      ).toEqual(obs.orderByValueLimitToLast2);

      expect(
        await queryKeys(playersPath, {
          orderBy: { kind: 'child', path: 'tier' },
          bounds: [{ kind: 'equalTo', value: 'gold' }],
          limit: null,
        }),
      ).toEqual(obs.orderByChildEqualToGold);
      expect(
        await queryKeys(playersPath, {
          orderBy: { kind: 'child', path: 'tier' },
          bounds: [{ kind: 'equalTo', value: 'gold', key: 'p3' }],
          limit: null,
        }),
      ).toEqual(obs.orderByChildEqualToGoldWithKeyP3);
      expect(
        await queryKeys(playersPath, {
          orderBy: { kind: 'child', path: 'score' },
          bounds: [
            { kind: 'startAt', value: 20.0 },
            { kind: 'endAt', value: 30.0 },
          ],
          limit: null,
        }),
      ).toEqual(obs.orderByChildScoreRange20To30);
      expect(
        await queryKeys(playersPath, {
          orderBy: { kind: 'child', path: 'score' },
          bounds: [],
          limit: { kind: 'limitToLast', n: 2 },
        }),
      ).toEqual(obs.orderByChildScoreLimitToLast2);

      const deniedPath = `pyric_oracle/${runId}/denied_zone/secret`;
      const deniedReadPromise = new Promise<{ code?: string; message?: string }>(
        (resolveDenied, rejectDenied) => {
          const timer = setTimeout(() => {
            rejectDenied(new Error('Timed out waiting for denied RTDB subscription error'));
          }, 5_000);
          harness.subscribe(
            'rsub-denied-1',
            {
              target: { service: 'rtdb', instance: DEDICATED_INSTANCE, path: deniedPath },
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
        const deniedSubErr = await deniedReadPromise;
        let errCode = '';
        if (typeof deniedSubErr.code === 'string') {
          errCode = deniedSubErr.code.toLowerCase();
        }
        let errMsg = '';
        if (typeof deniedSubErr.message === 'string') {
          errMsg = deniedSubErr.message.toLowerCase();
        }
        const mapsToPermissionDenied =
          errCode === 'permission-denied' ||
          errCode === 'permission_denied' ||
          errMsg.includes('permission_denied') ||
          errMsg.includes('permission denied');
        expect(mapsToPermissionDenied).toBe(obs.deniedReadCancelledWithPermissionDenied);
        expect(obs.deniedReadErrorCode).toBe(-3);
      } finally {
        harness.unsubscribe('rsub-denied-1');
      }

      const deniedWriteRes = await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: deniedPath,
        value: 'forbidden',
        actAs,
      });
      expect(!deniedWriteRes.ok).toBe(obs.deniedWriteThrewDatabaseException);
      let writeErrMsg = '';
      if (!deniedWriteRes.ok && deniedWriteRes.error !== undefined) {
        writeErrMsg = deniedWriteRes.error.message;
      }
      expect(
        writeErrMsg.toLowerCase().includes('permission_denied') ||
          writeErrMsg.toLowerCase().includes('permission denied'),
      ).toBe(obs.deniedWriteMessageMentionsPermissionDenied);
    } finally {
      await harness.close();
    }
  });

  test('replays .info/connected toggle, Value/Child listeners, removeEventListener, runTransaction/abort, and two-app OnDisconnect', async () => {
    const obs = gate.load<RtdbKotlinListenersTxConnectionOnDisconnectObservation>(
      'rtdb-kotlin-listeners-transactions-connection-and-ondisconnect',
    );
    await verifyWave4ListenersTransactionsAndOnDisconnect(obs);
  });

  test('covers all 3 committed Wave 4 rtdb-kotlin observations through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'rtdb-kotlin-listeners-transactions-connection-and-ondisconnect',
      'rtdb-kotlin-navigation-push-priorities-and-snapshots',
      'rtdb-kotlin-queries-ranges-limits-and-permission-denied',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
