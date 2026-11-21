import { expect } from 'bun:test';
import {
  DOC_VALUE_ENCODING,
  type HostedFirestoreRulesBridge,
} from './firestore-kotlin-oracle-replay-harness.ts';

export interface FirestoreKotlinWave5InstanceFlowsObservation {
  defaultInstanceSameAsKtx: boolean;
  defaultInstanceAppName: string;
  namedInstanceSameAsKtx: boolean;
  defaultAndNamedInstancesDistinct: boolean;
  settingsDefaultHost: string;
  settingsDefaultSslEnabled: boolean;
  settingsPersistentCacheConfigured: boolean;
  settingsPersistentCacheSizeBytes: number;
  settingsCustomHost: string;
  settingsCustomSslEnabled: boolean;
  settingsMemoryCacheConfigured: boolean;
  settingsReconfigureAfterStartThrowsIllegalState: boolean;
  directDocEqualsCollectionChain: boolean;
  directDocId: string;
  directDocParentId: string;
  directDocOddSegmentsThrowsIllegalArgument: boolean;
  updateMapPreservedHandle: string;
  updateMapUpdatedLevel: number;
  updateMapNestedReviews: number;
  updateMapPreservedCommits: number;
  updateMapDeletedFieldPresent: boolean;
  updateMissingDocErrorCodeName: string;
  updateMissingDocErrorCodeValue: number;
  toObjectDocumentId: string;
  toObjectHandle: string;
  toObjectLevel: number;
  toObjectScore: number;
  toObjectActive: boolean;
  toObjectTags: string[];
  toObjectNestedBadgeCode: string;
  toObjectNestedBadgeTier: number;
  toObjectClassMatchesReified: boolean;
  toObjectMissingDocReturnsNull: boolean;
  inSyncFiredOnAttach: boolean;
  inSyncFiredAfterWrite: boolean;
  inSyncQuietAfterRemove: boolean;
  docSnapshotsExcludeStages: string[];
  docSnapshotsIncludeObservedPendingAndSynced: boolean;
  docSnapshotsQuietAfterCancel: boolean;
  querySnapshotsEmissionHistory: string[][];
  querySnapshotsLatestToObjects: string[];
  querySnapshotsQuietAfterCancel: boolean;
}

export interface FirestoreKotlinWave5InequalityCgTxObservation {
  whereNotEqualToTierIds: string[];
  whereNotEqualToScoreIds: string[];
  whereLessThanIds: string[];
  whereLessThanOrEqualToIds: string[];
  whereGreaterThanIds: string[];
  whereGreaterThanOrEqualToIds: string[];
  openRangeDescIds: string[];
  whereNotInTierIds: string[];
  whereNotInScoreIds: string[];
  cursorStartAtValuesLimit2Ids: string[];
  cursorStartAfterEndAtValuesIds: string[];
  cursorDescStartAfterEndBeforeValuesIds: string[];
  cursorStartAtEndAtDocSnapshotIds: string[];
  cursorStartAfterEndBeforeDocSnapshotIds: string[];
  cursorDescStartAtEndAtDocSnapshotIds: string[];
  collectionGroupEmptyThrowsIllegalArgument: boolean;
  collectionGroupSlashThrowsIllegalArgument: boolean;
  collectionGroupIdsSorted: string[];
  collectionGroupRedactedPathsSorted: string[];
  collectionGroupUnscopedDeniedCodeName: string;
  txInvalidMaxAttemptsThrowsIllegalArgument: boolean;
  txRetryAttempts: number;
  txRetryObservedCounters: number[];
  txRetryReturnCounter: number;
  txRetryFinalCounter: number;
  txDeletedTargetExistsAfterCommit: boolean;
  txExhaustedMaxAttempts: number;
  txExhaustedAttempts: number;
  txExhaustedThrew: boolean;
  txExhaustedErrorCodeName: string;
  txExhaustedErrorCodeValue: number;
  txExhaustedFinalCounter: number;
}

export const INSTANCE_FLOWS_STEM = 'firestore-kotlin-instance-flows-inSync-and-toObject';
export const INEQUALITY_CG_TX_STEM =
  'firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry';

export const WAVE5_FILENAMES = new Set([
  `${INSTANCE_FLOWS_STEM}.json`,
  `${INEQUALITY_CG_TX_STEM}.json`,
]);

export function waitUntilCondition(
  label: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  if (predicate()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveWait, rejectWait) => {
    const started = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolveWait();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(interval);
        rejectWait(new Error(`Timed out waiting for Wave 5 replay condition '${label}'`));
      }
    }, 15);
  });
}

export function docCursorConstraint(
  kind: 'startAt' | 'startAfter' | 'endAt' | 'endBefore',
  score: number,
  docPath: string,
): Record<string, unknown> {
  return {
    kind,
    values: [score, { __type: 'reference', path: docPath }],
    fromSnapshot: true,
    valueEncoding: DOC_VALUE_ENCODING,
  };
}

export async function seedWave5ScoreCollection(
  harness: HostedFirestoreRulesBridge,
  colPath: string,
): Promise<void> {
  const entries = [
    { id: 'd1', tier: 'bronze', score: 10 },
    { id: 'd2', tier: 'silver', score: 20 },
    { id: 'd3', tier: 'gold', score: 30 },
    { id: 'd4', tier: 'platinum', score: 40 },
    { id: 'd5', tier: 'diamond', score: 50 },
  ];
  const writes = entries.map((entry) => ({
    method: 'set',
    path: `${colPath}/${entry.id}`,
    data: { tier: entry.tier, score: entry.score },
  }));
  const batchRes = await harness.sendOp({
    method: 'batchCommit',
    writes,
    actAs: harness.actAs,
  });
  expect(batchRes.ok).toBe(true);
}
