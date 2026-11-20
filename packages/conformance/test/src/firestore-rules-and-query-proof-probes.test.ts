import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type QueryConstraint,
  type QuerySnapshot,
} from 'pyric/firestore';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import {
  type QueryProofReadRulesSubject,
  buildQueryProofRulesBlock,
  observeFirestoreQueryProofAndReadRules,
  probe as queryProofProbe,
  seedDataForQueryProof,
} from '../../probes/firestore/firestore-query-proof-and-read-rules.ts';
import {
  type ProbeClientKind,
  type RulesWriteAndCrossDocSubject,
  buildWriteAndCrossDocRulesBlock,
  observeFirestoreRulesWriteAndCrossDoc,
  probe as writeCrossDocProbe,
  seedDataForWriteAndCrossDoc,
} from '../../probes/firestore/firestore-rules-write-and-cross-doc-verdicts.ts';
import {
  CEL_PROBE_CASE_IDS,
  type RulesCelAndSetEqualitySubject,
  buildCelAndSetEqualityRulesBlock,
  observeFirestoreRulesCelAndSetEquality,
  probe as celSetEqualityProbe,
  seedDataForCelAndSetEquality,
} from '../../probes/firestore/firestore-rules-cel-expressions-and-set-equality.ts';

const FIRESTORE_RULES_WAVE2_PROBE_IDS = [
  'firestore-query-proof-and-read-rules',
  'firestore-rules-cel-expressions-and-set-equality',
  'firestore-rules-write-and-cross-doc-verdicts',
] as const;

function wrapRulesBlock(block: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`;
}

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === 'string') return raw;
  }
  return 'unknown';
}

describe('Firestore Wave 2 query-proof and security-rules client SDK probes', () => {
  test('registers all 3 linked sdk-probes with rowIds and inert preview safety', async () => {
    expect(CEL_PROBE_CASE_IDS.length).toBe(22);
    expect(auditProbeSessionAuthModes()).toEqual([]);
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_RULES_WAVE2_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(queryProofProbe.pendingRowLink).toBeUndefined();
    expect(queryProofProbe.matrixRow).toBe('firestore#24a');
    expect(queryProofProbe.rowIds).toEqual([
      'firestore#24a',
      'firestore#24b',
      'firestore#139',
      'firestore#139a',
    ]);
    expect(writeCrossDocProbe.pendingRowLink).toBeUndefined();
    expect(writeCrossDocProbe.matrixRow).toBe('firestore#128');
    expect(writeCrossDocProbe.rowIds).toEqual([
      'firestore#128',
      'firestore#129',
      'firestore#130',
      'firestore#131',
      'firestore#132',
      'firestore#137',
      'firestore#RS2',
      'firestore#RS3',
    ]);
    expect(celSetEqualityProbe.pendingRowLink).toBeUndefined();
    expect(celSetEqualityProbe.matrixRow).toBe('firestore#133');
    expect(celSetEqualityProbe.rowIds).toEqual([
      'firestore#133',
      'firestore#134',
      'firestore#135',
      'firestore#136',
      'firestore#136b',
      'firestore#138',
    ]);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of FIRESTORE_RULES_WAVE2_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded.filter((entry) =>
        (FIRESTORE_RULES_WAVE2_PROBE_IDS as readonly string[]).includes(entry.id),
      ),
      log: (line) => previewLines.push(line),
    });
    expect(previewLines.join('\n')).toContain('firestore-query-proof-and-read-rules');
    expect(previewLines.join('\n')).toContain('firestore-rules-write-and-cross-doc-verdicts');
    expect(previewLines.join('\n')).toContain('firestore-rules-cel-expressions-and-set-equality');
  });

  test('executes query-proof and read-rules observer cleanly against pyric/firestore', async () => {
    const runId = 'local_qp';
    const basePath = `__pyric_fs_probe/${runId}`;
    const clientUid = 'alice';
    const sandbox = initializeSandbox();
    setRules(sandbox, wrapRulesBlock(buildQueryProofRulesBlock(runId)));
    const prefixedSeeds: Record<string, Record<string, unknown>> = {};
    for (const [rel, data] of Object.entries(seedDataForQueryProof(clientUid))) {
      prefixedSeeds[`${basePath}/${rel}`] = data;
    }
    seedDocuments(sandbox, prefixedSeeds);

    const authedDb = getFirestore(sandbox.withAuth({ uid: clientUid }));
    const unauthedDb = getFirestore(sandbox.withAuth(null));
    const dbFor = (authed: boolean) => {
      if (authed) return authedDb;
      return unauthedDb;
    };

    const subject: QueryProofReadRulesSubject = {
      clientUid,
      async readDocOutcome(relPath, authed) {
        try {
          await getDoc(doc(dbFor(authed), `${basePath}/${relPath}`));
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
      async queryIdsOrError(relCollection, opts) {
        try {
          const col = collection(dbFor(opts.authed), `${basePath}/${relCollection}`);
          const constraints: QueryConstraint[] = [];
          if (opts.whereEqual !== undefined) {
            constraints.push(where(opts.whereEqual.field, '==', opts.whereEqual.value));
          }
          if (opts.limitCount !== undefined) {
            constraints.push(limit(opts.limitCount));
          }
          const snap = await getDocs(query(col, ...constraints));
          return { ok: true, ids: snap.docs.map((d) => d.id).sort() };
        } catch (err) {
          return { ok: false, code: errorCodeOf(err) };
        }
      },
      async countOrError(relCollection, opts) {
        try {
          const col = collection(dbFor(opts.authed), `${basePath}/${relCollection}`);
          const constraints: QueryConstraint[] = [];
          if (opts.whereEqual !== undefined) {
            constraints.push(where(opts.whereEqual.field, '==', opts.whereEqual.value));
          }
          const snap = await getCountFromServer(query(col, ...constraints));
          return { ok: true, count: snap.data().count };
        } catch (err) {
          return { ok: false, code: errorCodeOf(err) };
        }
      },
      async firstSnapshotIdsOrError(relCollection, whereEqual) {
        const col = collection(authedDb, `${basePath}/${relCollection}`);
        const constraints: QueryConstraint[] = [];
        if (whereEqual !== undefined) {
          constraints.push(where(whereEqual.field, '==', whereEqual.value));
        }
        return new Promise((resolve) => {
          let stop: () => void = () => {};
          stop = onSnapshot(
            query(col, ...constraints),
            (rawSnap) => {
              stop();
              const snap = rawSnap as QuerySnapshot;
              resolve({ ok: true, ids: snap.docs.map((d) => d.id).sort() });
            },
            (err) => {
              stop();
              resolve({ ok: false, code: errorCodeOf(err) });
            },
          );
        });
      },
    };

    const result = await observeFirestoreQueryProofAndReadRules(subject);
    sandbox.dispose();

    expect(result).toEqual({
      denyAllGetDocs: { ok: false, code: 'permission-denied' },
      denyAllCount: { ok: false, code: 'permission-denied' },
      unauthedGetDocs: { ok: false, code: 'permission-denied' },
      authedGetDocs: { ok: true, ids: ['a'] },
      unfilteredVisibilityList: { ok: false, code: 'permission-denied' },
      provablePublicList: { ok: true, ids: ['pub1', 'pub2'] },
      perDocGetOnPublicItem: 'error:permission-denied',
      provablePublicCount: { ok: true, count: 2 },
      unfilteredVisibilityCount: { ok: false, code: 'permission-denied' },
      provableOwnerList: { ok: true, ids: ['mine'] },
      provableSnapshot: { ok: true, ids: ['pub1', 'pub2'] },
      unprovableSnapshot: { ok: true, ids: ['mine', 'pub1', 'pub2'] },
      limitTwoOk: true,
      limitTwoCount: 2,
      limitThree: { ok: false, code: 'permission-denied' },
      unlimitedList: { ok: false, code: 'permission-denied' },
    });
  });

  test('executes write and cross-doc observer cleanly against pyric/firestore', async () => {
    const runId = 'local_wc';
    const basePath = `__pyric_fs_probe/${runId}`;
    const plainUid = 'bob';
    const sandbox = initializeSandbox();
    setRules(sandbox, wrapRulesBlock(buildWriteAndCrossDocRulesBlock(runId)));
    const prefixedSeeds: Record<string, Record<string, unknown>> = {};
    for (const [rel, data] of Object.entries(seedDataForWriteAndCrossDoc(plainUid))) {
      prefixedSeeds[`${basePath}/${rel}`] = data;
    }
    seedDocuments(sandbox, prefixedSeeds);

    const unauthedDb = getFirestore(sandbox.withAuth(null));
    const plainDb = getFirestore(sandbox.withAuth({ uid: plainUid }));
    const claimedDb = getFirestore(
      sandbox.withAuth({ uid: 'editor_1', token: { role: 'editor', tier: 2 } }),
    );
    const dbFor = (kind: ProbeClientKind) => {
      if (kind === 'claimed') return claimedDb;
      if (kind === 'plain') return plainDb;
      return unauthedDb;
    };

    const subject: RulesWriteAndCrossDocSubject = {
      async readOutcome(kind, relPath) {
        try {
          await getDoc(doc(dbFor(kind), `${basePath}/${relPath}`));
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
      async setOutcome(kind, relPath, data) {
        try {
          await setDoc(doc(dbFor(kind), `${basePath}/${relPath}`), data);
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
      async updateOutcome(kind, relPath, data) {
        try {
          await updateDoc(doc(dbFor(kind), `${basePath}/${relPath}`), data);
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
    };

    const result = await observeFirestoreRulesWriteAndCrossDoc(subject, plainUid);
    sandbox.dispose();

    expect(result).toEqual({
      anonOnly: {
        unauthedRead: 'allowed',
        signedInRead: 'error:permission-denied',
      },
      crossDoc: {
        enabledAclRead: 'allowed',
        disabledAclRead: 'error:permission-denied',
        existsGuardMissingAclRead: 'error:permission-denied',
        crossDocIdRead: 'allowed',
        crossDocIdNotEqZzzRead: 'allowed',
        crossDocNameRead: 'allowed',
        unguardedMissingGetRead: 'error:permission-denied',
      },
      requestResourceValidation: {
        validCreate: 'allowed',
        emptyTitleCreate: 'error:permission-denied',
        nonStringTitleCreate: 'error:permission-denied',
        missingTitleFieldCreate: 'error:permission-denied',
      },
      existingResourceField: {
        ownerMatchUpdate: 'allowed',
        ownerChangeAttempt: 'error:permission-denied',
        ownerMismatchUpdate: 'error:permission-denied',
        missingOwnerFieldOnExistingDoc: 'error:permission-denied',
      },
      customClaims: {
        claimedWrite: 'allowed',
        plainSignedInWrite: 'error:permission-denied',
        unauthedWrite: 'error:permission-denied',
      },
      updateMergedRequestResource: {
        sparseUpdatePreservingKeep: 'allowed',
        fullSetDroppingKeep: 'error:permission-denied',
      },
    });
  });

  test('executes CEL expressions and FirestoreSet equality observer cleanly against pyric/firestore', async () => {
    const runId = 'local_cel';
    const basePath = `__pyric_fs_probe/${runId}`;
    const sandbox = initializeSandbox();
    setRules(sandbox, wrapRulesBlock(buildCelAndSetEqualityRulesBlock(runId)));
    const prefixedSeeds: Record<string, Record<string, unknown>> = {};
    for (const [rel, data] of Object.entries(seedDataForCelAndSetEquality())) {
      prefixedSeeds[`${basePath}/${rel}`] = data;
    }
    seedDocuments(sandbox, prefixedSeeds);

    const db = getFirestore(sandbox.withAuth({ uid: 'carol' }));
    const subject: RulesCelAndSetEqualitySubject = {
      async readOutcome(relPath) {
        try {
          await getDoc(doc(db, `${basePath}/${relPath}`));
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
      async setOutcome(relPath, data) {
        try {
          await setDoc(doc(db, `${basePath}/${relPath}`), data);
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
      async updateOutcome(relPath, data) {
        try {
          await updateDoc(doc(db, `${basePath}/${relPath}`), data);
          return 'allowed';
        } catch (err) {
          return `error:${errorCodeOf(err)}`;
        }
      },
    };

    const result = await observeFirestoreRulesCelAndSetEquality(subject);
    sandbox.dispose();

    expect(result).toEqual({
      readCases: {
        dot_missing: 'error:permission-denied',
        index_missing_eq_null: 'error:permission-denied',
        present_null: 'allowed',
        error_or_true: 'allowed',
        true_or_error: 'allowed',
        error_and_false: 'allowed',
        in_and_map_get: 'allowed',
        list_oob: 'error:permission-denied',
        matches_partial: 'error:permission-denied',
        matches_full_replace_split: 'allowed',
        proto_in_tostring: 'error:permission-denied',
        proto_dot_constructor: 'error:permission-denied',
        proto_own_keys_only: 'allowed',
        bad_plus_str_int: 'error:permission-denied',
        bad_plus_lists: 'error:permission-denied',
        list_concat_and_is_map: 'allowed',
        cross_type_lt: 'error:permission-denied',
        int_float_and_div: 'allowed',
        div_by_zero: 'error:permission-denied',
        bad_int_parse: 'error:permission-denied',
        unknown_bool_fn: 'error:permission-denied',
        non_bool_and: 'error:permission-denied',
      },
      setEquality: {
        exactOrderInsensitiveMatch: 'allowed',
        partialSetMismatch: 'error:permission-denied',
      },
      createVerdicts: {
        requestResourceFloatAllowed: 'allowed',
        requestResourceIntDenied: 'error:permission-denied',
        resourceEqNullOnCreateDenied: 'error:permission-denied',
        readingResourceDataOnCreateDenied: 'error:permission-denied',
      },
    });
  });
});
