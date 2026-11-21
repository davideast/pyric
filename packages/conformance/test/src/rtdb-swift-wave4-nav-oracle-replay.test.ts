import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { buildIosRtdbNavigationAndChildQueryRules } from '../../src/ios-oracle-runtime.ts';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';
import {
  DEDICATED_INSTANCE,
  extractEntryKeys,
  extractRtdbSnap,
} from './rtdb-kotlin-wave4-oracle-replay-harness.ts';

interface RtdbSwiftNavigationPushPrioritiesSnapshotsObservation {
  arrayValueKind: string;
  booleanValueKind: string;
  cleanupRemovedRunNode: boolean;
  deepChildSnapshotInnerValue: number;
  defaultInstanceIdentical: boolean;
  defaultPriorityOrderedValues: string[];
  defaultRootMatchesDatabaseUrl: boolean;
  dictionaryValueKind: string;
  existedBeforeSetNil: boolean;
  existsAfterSetNil: boolean;
  explicitPriorityOrderedValues: string[];
  exportFormatHasValueAndPriority: boolean;
  floatingValueKind: string;
  fromUrlMatchesKeyAndUrl: boolean;
  hasChildDeepNestedInner: boolean;
  hasChildMissing: boolean;
  hasChildNested: boolean;
  hasChildrenTrue: boolean;
  integralValueEquals42: boolean;
  integralValueKind: string;
  missingSnapshotChildrenCount: number;
  missingSnapshotExists: boolean;
  missingSnapshotHasChildren: boolean;
  missingSnapshotPriorityKind: string;
  missingSnapshotValueKind: string;
  namedAppMatches: boolean;
  namedDatabaseIdentical: boolean;
  nestedDescriptionSuffixMatches: boolean;
  nestedGrandParentKey: string;
  nestedKey: string;
  nestedParentKey: string;
  nestedRootKeyIsNil: boolean;
  nestedRootUrlMatchesRoot: boolean;
  nestedUrlSuffixMatches: boolean;
  orderByChildEqualToGold: string[];
  orderByChildEqualToGoldWithKeyP3: string[];
  orderByChildScoreExclusiveRangeAfter10Before40: string[];
  orderByChildScoreInclusiveRange20To30: string[];
  orderByChildScoreLimitToFirst2: string[];
  orderByChildScoreLimitToLast2: string[];
  priorityKindAfterSetNil: string;
  pushKeyLength: number;
  pushKeysLexicographicallyMonotonic: boolean;
  pushOrderedValues: string[];
  rootKeyIsNil: boolean;
  rootParentIsNil: boolean;
  rootSelfUrlMatches: boolean;
  rootUrlMatchesDatabaseUrl: boolean;
  serverTimestampPlausibleEpochMs: boolean;
  serverTimestampValueKind: string;
  setPriorityNumericKind: string;
  setPriorityNumericValue: number;
  setPriorityPreservedValue: string;
  setValueWithNumericPriority: number;
  setValueWithStringPriority: string;
  setValueWithStringPriorityKind: string;
  stringValueKind: string;
  urlInstanceIdentical: boolean;
  valueKindAfterSetNil: string;
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

const gate = createObservationGate({
  dir: RTDB_SWIFT_OBSERVATIONS_DIR,
  match: (filename) => filename === 'rtdb-swift-navigation-push-priorities-and-snapshots.json',
});

describe('rtdb-swift Wave 4 navigation, push, priorities, snapshots, and child queries replay', () => {
  test('replays Database instances, reference navigation, childByAutoId, priorities, setValue(nil), and queryOrdered(byChild:)', async () => {
    const obs = gate.load<RtdbSwiftNavigationPushPrioritiesSnapshotsObservation>(
      'rtdb-swift-navigation-push-priorities-and-snapshots',
    );

    const dbSwift = readFileSync(join(SWIFT_DATABASE_SOURCE_DIR, 'Database.swift'), 'utf8');
    const refSwift = readFileSync(
      join(SWIFT_DATABASE_SOURCE_DIR, 'DatabaseReference.swift'),
      'utf8',
    );
    const snapSwift = readFileSync(join(SWIFT_DATABASE_SOURCE_DIR, 'DataSnapshot.swift'), 'utf8');
    const querySwift = readFileSync(join(SWIFT_DATABASE_SOURCE_DIR, 'DatabaseQuery.swift'), 'utf8');

    expect(dbSwift).toContain('public static func database() -> Database');
    expect(dbSwift).toContain('public static func database(url: String) -> Database');
    expect(dbSwift).toContain('public static func database(app: FirebaseApp, url: String) -> Database');
    expect(dbSwift).toContain('public func reference(fromURL databaseUrl: String) -> DatabaseReference');
    expect(refSwift).toContain('if path == "/" {\n            return nil\n        }');
    expect(refSwift).toContain('public var root: DatabaseReference');
    expect(refSwift).toContain('public var url: String');
    expect(snapSwift).toContain('public func valueInExportFormat() -> Any?');
    expect(snapSwift).toContain('public func childSnapshot(forPath childPathString: String) -> DataSnapshot');
    expect(querySwift).toContain('public func queryStarting(afterValue value: Any?, childKey: String? = nil)');
    expect(querySwift).toContain('public func queryEnding(beforeValue value: Any?, childKey: String? = nil)');

    expect(obs.defaultInstanceIdentical).toBe(true);
    expect(obs.defaultRootMatchesDatabaseUrl).toBe(true);
    expect(obs.urlInstanceIdentical).toBe(true);
    expect(obs.namedAppMatches).toBe(true);
    expect(obs.namedDatabaseIdentical).toBe(true);
    expect(obs.rootKeyIsNil).toBe(true);
    expect(obs.rootParentIsNil).toBe(true);
    expect(obs.rootSelfUrlMatches).toBe(true);
    expect(obs.rootUrlMatchesDatabaseUrl).toBe(true);
    expect(obs.nestedKey).toBe('leaf_node');
    expect(obs.nestedParentKey).toBe('section');
    expect(obs.nestedGrandParentKey).toBe('nav');
    expect(obs.nestedRootKeyIsNil).toBe(true);
    expect(obs.nestedRootUrlMatchesRoot).toBe(true);
    expect(obs.nestedUrlSuffixMatches).toBe(true);
    expect(obs.nestedDescriptionSuffixMatches).toBe(true);
    expect(obs.fromUrlMatchesKeyAndUrl).toBe(true);
    expect(obs.stringValueKind).toBe('String');
    expect(obs.integralValueKind).toBe('NSNumber');
    expect(obs.floatingValueKind).toBe('NSNumber');
    expect(obs.booleanValueKind).toBe('Bool');
    expect(obs.arrayValueKind).toBe('Array');
    expect(obs.dictionaryValueKind).toBe('Dictionary');
    expect(obs.serverTimestampValueKind).toBe('NSNumber');
    expect(obs.setPriorityNumericKind).toBe('NSNumber');
    expect(obs.setValueWithStringPriorityKind).toBe('String');
    expect(obs.missingSnapshotValueKind).toBe('NSNull');
    expect(obs.missingSnapshotPriorityKind).toBe('NSNull');
    expect(obs.valueKindAfterSetNil).toBe('NSNull');
    expect(obs.priorityKindAfterSetNil).toBe('NSNull');

    const projectId = `demo-ios-rtdb-nav-${Date.now()}`;
    const runId = 'replay_ios_rtdb_nav_1';
    const uid = 'ios-rtdb-nav-uid';
    const defaultRules = { rules: { '.read': false, '.write': false } };
    const dedicatedRules = {
      rules: {
        pyric_oracle: {
          [runId]: buildIosRtdbNavigationAndChildQueryRules(),
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
      const signInRes = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken,
      });
      expect(signInRes.ok).toBe(true);
      const actAs = { mode: 'as' as const, uid };
      const runPath = `pyric_oracle/${runId}`;

      const pushPath = `${runPath}/pushed_items`;
      const pushKeys: string[] = [];
      for (const label of ['first', 'second', 'third']) {
        const pushRes = await harness.sendOp({
          method: 'rtdb.push',
          instance: DEDICATED_INSTANCE,
          path: pushPath,
          value: label,
          actAs,
        });
        expect(pushRes.ok).toBe(true);
        const pushVal = pushRes.value as { key: string };
        pushKeys.push(pushVal.key);
      }
      const k1 = String(pushKeys[0]);
      const k2 = String(pushKeys[1]);
      const k3 = String(pushKeys[2]);
      expect(k1.length).toBe(obs.pushKeyLength);
      expect(k1.length === 20 && k2.length === 20 && k3.length === 20 && k1 < k2 && k2 < k3).toBe(
        obs.pushKeysLexicographicallyMonotonic,
      );

      const pushOrderedSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: pushPath,
          query: { orderBy: { kind: 'key' }, bounds: [], limit: null },
          actAs,
        }),
      );
      expect(pushOrderedSnap.entries.map((entry) => entry.value)).toEqual(obs.pushOrderedValues);

      const typesPath = `${runPath}/value_types`;
      await harness.sendOp({
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

      const typesSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: typesPath,
          actAs,
        }),
      );
      const typesMap = typesSnap.value as Record<string, unknown>;
      const nestedMap = typesMap.nested as Record<string, unknown>;
      expect(typesMap.whole === 42).toBe(obs.integralValueEquals42);
      expect('nested' in typesMap).toBe(obs.hasChildNested);
      expect('inner' in nestedMap).toBe(obs.hasChildDeepNestedInner);
      expect('nonexistent' in typesMap).toBe(obs.hasChildMissing);
      expect(typesSnap.size > 0).toBe(obs.hasChildrenTrue);
      expect(nestedMap.inner).toBe(obs.deepChildSnapshotInnerValue);
      const stampedEpoch = Number(typesMap.stampedAt);
      expect(stampedEpoch >= 1_700_000_000_000 && stampedEpoch < 4_102_444_800_000).toBe(
        obs.serverTimestampPlausibleEpochMs,
      );

      const missingSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: `${runPath}/missing_leaf`,
          actAs,
        }),
      );
      expect(missingSnap.exists).toBe(obs.missingSnapshotExists);
      expect(missingSnap.size > 0).toBe(obs.missingSnapshotHasChildren);
      expect(missingSnap.size).toBe(obs.missingSnapshotChildrenCount);

      const prioPath = `${runPath}/priority_items`;
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
        priority: 20,
        actAs,
      });
      await harness.sendOp({
        method: 'rtdb.setWithPriority',
        instance: DEDICATED_INSTANCE,
        path: pFirstPath,
        value: 'first-with-priority',
        priority: 5,
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
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: pSecondPath,
          actAs,
        }),
      );
      const pFirstSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: pFirstPath,
          actAs,
        }),
      );
      const pThirdSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: pThirdPath,
          actAs,
        }),
      );
      const defaultPrioSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: prioPath,
          actAs,
        }),
      );
      const explicitPrioSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: prioPath,
          query: { orderBy: { kind: 'priority' }, bounds: [], limit: null },
          actAs,
        }),
      );

      expect(pSecondSnap.value).toBe(obs.setPriorityPreservedValue);
      expect(pSecondSnap.priority).toBe(obs.setPriorityNumericValue);
      expect(pFirstSnap.priority).toBe(obs.setValueWithNumericPriority);
      expect(pThirdSnap.priority).toBe(obs.setValueWithStringPriority);
      const exportFirst = pFirstSnap.exportValue as Record<string, unknown>;
      expect(
        exportFirst['.value'] === 'first-with-priority' && exportFirst['.priority'] === 5,
      ).toBe(obs.exportFormatHasValueAndPriority);
      expect(defaultPrioSnap.entries.map((entry) => entry.value)).toEqual(
        obs.defaultPriorityOrderedValues,
      );
      expect(explicitPrioSnap.entries.map((entry) => entry.value)).toEqual(
        obs.explicitPriorityOrderedValues,
      );

      expect(pThirdSnap.exists).toBe(obs.existedBeforeSetNil);
      await harness.sendOp({
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: pThirdPath,
        value: null,
        actAs,
      });
      const afterNilSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: pThirdPath,
          actAs,
        }),
      );
      expect(afterNilSnap.exists).toBe(obs.existsAfterSetNil);

      const playersPath = `${runPath}/players`;
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

      const queryKeys = (query: Record<string, unknown>) =>
        harness
          .sendOp({ method: 'rtdb.get', instance: DEDICATED_INSTANCE, path: playersPath, query, actAs })
          .then(extractEntryKeys);

      expect(
        await queryKeys({
          orderBy: { kind: 'child', path: 'tier' },
          bounds: [{ kind: 'equalTo', value: 'gold' }],
          limit: null,
        }),
      ).toEqual(obs.orderByChildEqualToGold);

      expect(
        await queryKeys({
          orderBy: { kind: 'child', path: 'tier' },
          bounds: [{ kind: 'equalTo', value: 'gold', key: 'p3' }],
          limit: null,
        }),
      ).toEqual(obs.orderByChildEqualToGoldWithKeyP3);

      expect(
        await queryKeys({
          orderBy: { kind: 'child', path: 'score' },
          bounds: [
            { kind: 'startAt', value: 20 },
            { kind: 'endAt', value: 30 },
          ],
          limit: null,
        }),
      ).toEqual(obs.orderByChildScoreInclusiveRange20To30);

      expect(
        await queryKeys({
          orderBy: { kind: 'child', path: 'score' },
          bounds: [
            { kind: 'startAfter', value: 10 },
            { kind: 'endBefore', value: 40 },
          ],
          limit: null,
        }),
      ).toEqual(obs.orderByChildScoreExclusiveRangeAfter10Before40);

      expect(
        await queryKeys({
          orderBy: { kind: 'child', path: 'score' },
          bounds: [],
          limit: { kind: 'limitToFirst', n: 2 },
        }),
      ).toEqual(obs.orderByChildScoreLimitToFirst2);

      expect(
        await queryKeys({
          orderBy: { kind: 'child', path: 'score' },
          bounds: [],
          limit: { kind: 'limitToLast', n: 2 },
        }),
      ).toEqual(obs.orderByChildScoreLimitToLast2);

      await harness.sendOp({
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: runPath,
        actAs,
      });
      const removedRunSnap = extractRtdbSnap(
        await harness.sendOp({
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path: runPath,
          actAs,
        }),
      );
      expect(!removedRunSnap.exists).toBe(obs.cleanupRemovedRunNode);
    } finally {
      await harness.close();
    }
  });

  test('covers rtdb-swift-navigation-push-priorities-and-snapshots through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual(['rtdb-swift-navigation-push-priorities-and-snapshots']);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
