/**
 * Generative `firebase-admin/firestore` vs `pyric-admin/firestore` argument
 * differential suite across both local (`Sandbox`) and JSON-wire remote
 * (`RemoteSandbox`) arms.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  applicationDefault,
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getFirestore as getUpstreamFirestore } from 'firebase-admin/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { ADMIN_APP_TARGET, deleteApp, getApps, initializeApp } from 'pyric-admin/app';
import { getFirestore } from 'pyric-admin/firestore';

import {
  emitTypeWrongnessCandidates,
  makeCandidate,
  type CandidateValue,
} from '../argument-generator/argument-combinators.js';
import {
  createPyricFirestoreArm,
  toUpstreamDialectRuntime,
} from './firestore-argument-schemas.js';
import {
  emitDatabaseIdCandidates,
  emitGetAllInvocationCases,
  emitResourceAndFieldPathCases,
  type FirestoreDifferentialCase,
} from './firestore-combinators.js';
import {
  emitFieldValueAndWriteCases,
  emitUpdateCases,
} from './firestore-write-query-combinators.js';
import {
  emitBatchAndTransactionCases,
  emitQueryConstraintCases,
} from './firestore-query-batch-combinators.js';
import {
  captureFirestoreOutcome,
  compareFirestoreOutcomes,
  createOfflineUpstreamFirestoreHarness,
} from './upstream-firestore-oracle.js';

function invokeSingleAppAccessor(
  accessor: (app?: never) => unknown,
  candidate: CandidateValue,
): unknown {
  if (candidate.label === 'undefined') {
    return accessor();
  }
  return accessor(candidate.build() as never);
}

function invokeDatabaseIdAccessor(
  accessor: (app: never, databaseId?: never) => unknown,
  app: unknown,
  candidate: CandidateValue,
): unknown {
  if (candidate.label === 'undefined') {
    return accessor(app as never);
  }
  return accessor(app as never, candidate.build() as never);
}

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app).catch(() => {});
  for (const app of getUpstreamApps()) await deleteUpstreamApp(app).catch(() => {});
});

describe('generative Admin Firestore argument differential: getFirestore', () => {
  it('matches firebase-admin across app-handle wrong types, spoofed/bare handles, default-app, deleted-app, and databaseId types', async () => {
    const mismatches: string[] = [];

    const extraAppHandleCandidates: CandidateValue[] = [
      makeCandidate('bare-sandbox', () => initializeSandbox({ projectId: 'demo-project' })),
      makeCandidate('spoof-prod-target', () => ({ [ADMIN_APP_TARGET]: 'prod' })),
      makeCandidate('spoof-sandbox-target', () => ({ [ADMIN_APP_TARGET]: 'sandbox', sandbox: {} })),
    ];
    const allAppCandidates = [...emitTypeWrongnessCandidates(), ...extraAppHandleCandidates];

    // 1. No default app initialized: every candidate must be rejected on both sides.
    for (const candidate of allAppCandidates) {
      const uGet = await captureFirestoreOutcome(() =>
        invokeSingleAppAccessor(getUpstreamFirestore as (app?: never) => unknown, candidate),
      );
      const pGet = await captureFirestoreOutcome(() =>
        invokeSingleAppAccessor(getFirestore as (app?: never) => unknown, candidate),
      );
      const getDiff = compareFirestoreOutcomes(`no-app:getFirestore(${candidate.label})`, uGet, pGet);
      if (getDiff !== null) mismatches.push(getDiff);
    }

    // 2. Default app initialized: test default resolution, 1-arg candidates, and 2-arg databaseId candidates.
    const defaultUpstream = initializeUpstreamApp({
      projectId: 'demo-project',
      credential: applicationDefault(),
    });
    const sandbox = initializeSandbox({ projectId: 'demo-project' });
    const defaultPyric = initializeApp({ sandbox, projectId: 'demo-project' });
    try {
      for (const candidate of allAppCandidates) {
        const rawVal = candidate.build();
        const uGet = await captureFirestoreOutcome(() =>
          invokeSingleAppAccessor(getUpstreamFirestore as (app?: never) => unknown, candidate),
        );
        const pGet = await captureFirestoreOutcome(() =>
          invokeSingleAppAccessor(getFirestore as (app?: never) => unknown, candidate),
        );
        // Non-object non-string 1-arg values (number/boolean/symbol/bigint) fall back to getApp()
        // upstream when a default app exists, whereas string 1-arg `getFirestore(databaseId)` matches upstream directly.
        const isOneArgNonStringNonObjectFallback =
          candidate.label !== 'undefined' &&
          typeof rawVal !== 'string' &&
          (typeof rawVal !== 'object' || rawVal === null);
        if (!isOneArgNonStringNonObjectFallback) {
          const diff = compareFirestoreOutcomes(
            `with-default:getFirestore(${candidate.label})`,
            uGet,
            pGet,
          );
          if (diff !== null) mismatches.push(diff);
        }
      }

      // 3. 2-arg `getFirestore(app, databaseId)` across all databaseId candidates.
      for (const dbIdCandidate of emitDatabaseIdCandidates()) {
        const uDbId = await captureFirestoreOutcome(() =>
          invokeDatabaseIdAccessor(
            getUpstreamFirestore as (app: never, databaseId?: never) => unknown,
            defaultUpstream,
            dbIdCandidate,
          ),
        );
        const pDbId = await captureFirestoreOutcome(() =>
          invokeDatabaseIdAccessor(
            getFirestore as (app: never, databaseId?: never) => unknown,
            defaultPyric,
            dbIdCandidate,
          ),
        );
        const dbIdDiff = compareFirestoreOutcomes(
          `getFirestore(app, databaseId=${dbIdCandidate.label})`,
          uDbId,
          pDbId,
        );
        if (dbIdDiff !== null) mismatches.push(dbIdDiff);
      }
    } finally {
      await deleteUpstreamApp(defaultUpstream);
      await deleteApp(defaultPyric);
      sandbox.dispose();
    }

    // 4. Deleted app handle: both getFirestore(deletedApp) and admin.firestore(deletedApp) must reject.
    const delSandbox = initializeSandbox({ projectId: 'demo-project' });
    const delUpstream = initializeUpstreamApp(
      { projectId: 'demo-project', credential: applicationDefault() },
      'deleted-fs-up',
    );
    const delPyric = initializeApp(
      { sandbox: delSandbox, projectId: 'demo-project' },
      'deleted-fs-pyric',
    );
    await deleteUpstreamApp(delUpstream);
    await deleteApp(delPyric);
    try {
      const uDel = await captureFirestoreOutcome(() => getUpstreamFirestore(delUpstream));
      const pDel = await captureFirestoreOutcome(() => getFirestore(delPyric));
      const delDiff = compareFirestoreOutcomes('getFirestore(deletedApp)', uDel, pDel);
      if (delDiff !== null) mismatches.push(delDiff);
    } finally {
      delSandbox.dispose();
    }

    expect(mismatches).toEqual([]);
  });
});

for (const armKind of ['local', 'remote'] as const) {
  describe(`generative Admin Firestore argument differential (${armKind} sandbox arm)`, () => {
    async function assertCaseSuiteParity(
      cases: readonly FirestoreDifferentialCase[],
      options: { requireBothPreflightLayers?: boolean } = {},
    ): Promise<void> {
      expect(cases.length).toBeGreaterThan(0);
      const upstream = createOfflineUpstreamFirestoreHarness();
      const arm = await createPyricFirestoreArm(armKind);
      const upstreamRuntime = toUpstreamDialectRuntime(upstream);

      try {
        const mismatches: string[] = [];
        let sawPreflightRejected = false;
        let sawPreflightAccepted = false;

        for (const testCase of cases) {
          await arm.ensureSeeded();
          upstream.resetTransportFlag();

          const uOutcome = await captureFirestoreOutcome(
            () => testCase.invoke(upstreamRuntime),
            upstream.didReachRpc,
          );
          const pOutcome = await captureFirestoreOutcome(() => testCase.invoke(arm.runtime));

          if (uOutcome.acceptedPreflight === false) sawPreflightRejected = true;
          if (uOutcome.acceptedPreflight === true) sawPreflightAccepted = true;

          const diff = compareFirestoreOutcomes(testCase.label, uOutcome, pOutcome, {
            allowDeferredWhenUpstreamAccepts: testCase.allowDeferredWhenUpstreamAccepts === true,
            allowZeroLimitRejectionWhenUpstreamAccepts:
              testCase.allowZeroLimitRejectionWhenUpstreamAccepts === true,
            allowCommittedBatchSecondCommitRejection:
              testCase.allowCommittedBatchSecondCommitRejection === true,
          });
          if (diff !== null) {
            mismatches.push(diff);
          }
        }

        expect(mismatches).toEqual([]);
        if (options.requireBothPreflightLayers === true) {
          expect(sawPreflightRejected).toBe(true);
          expect(sawPreflightAccepted).toBe(true);
        }
      } finally {
        await upstream.dispose();
        await arm.dispose();
      }
    }

    it('matches firebase-admin on Firestore.getAll cardinality, element types, and ReadOptions (with documented deferred boundary)', async () => {
      await assertCaseSuiteParity(emitGetAllInvocationCases(), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on collection/doc/collectionGroup resource paths, FieldPath segments, and DocumentSnapshot.get', async () => {
      await assertCaseSuiteParity(emitResourceAndFieldPathCases(), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on FieldValue sentinels, DocumentData validation, SetOptions, and delete preconditions', async () => {
      await assertCaseSuiteParity(emitFieldValueAndWriteCases(), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on doc.update map/varargs, empty-map, sentinels, preconditions, and field-path conflicts', async () => {
      await assertCaseSuiteParity(emitUpdateCases(), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on Query where/orderBy/limit/limitToLast and FieldPath.documentId constraints', async () => {
      await assertCaseSuiteParity(emitQueryConstraintCases(), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on WriteBatch and runTransaction / Transaction argument validation', async () => {
      await assertCaseSuiteParity(emitBatchAndTransactionCases(), {
        requireBothPreflightLayers: true,
      });
    });

    it('preserves unbranded plain user maps with __type keys across set, update, get, and where', async () => {
      const arm = await createPyricFirestoreArm(armKind);
      try {
        const docRef = arm.db.doc('items/marker-plain-map');
        await docRef.set({
          meta: { __type: 'serverTimestamp' },
          delMap: { __type: 'deleteField' },
          incMap: { __type: 'increment', value: 'v1' },
        });
        const afterSet = await docRef.get();
        expect(afterSet.data()).toEqual({
          meta: { __type: 'serverTimestamp' },
          delMap: { __type: 'deleteField' },
          incMap: { __type: 'increment', value: 'v1' },
        });

        await docRef.update({
          updatedMeta: { __type: 'serverTimestamp' },
        });
        const afterUpdate = await docRef.get();
        expect(afterUpdate.get('updatedMeta')).toEqual({ __type: 'serverTimestamp' });

        const matched = await arm.db
          .collection('items')
          .where('meta', '==', { __type: 'serverTimestamp' })
          .get();
        expect(matched.docs.map((d) => d.id)).toEqual(['marker-plain-map']);
      } finally {
        await arm.dispose();
      }
    });
  });
}
