import { describe, it } from 'bun:test';
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
} from '../../../src/firestore/index.js';
import {
  buildQueryProofRulesBlock,
  observeFirestoreQueryProofAndReadRules,
  seedDataForQueryProof,
  type QueryProofReadRulesSubject,
} from '../../../../conformance/probes/firestore/firestore-query-proof-and-read-rules.ts';
import {
  buildWriteAndCrossDocRulesBlock,
  observeFirestoreRulesWriteAndCrossDoc,
  seedDataForWriteAndCrossDoc,
  type ProbeClientKind,
  type RulesWriteAndCrossDocSubject,
} from '../../../../conformance/probes/firestore/firestore-rules-write-and-cross-doc-verdicts.ts';
import {
  buildCelAndSetEqualityRulesBlock,
  observeFirestoreRulesCelAndSetEquality,
  seedDataForCelAndSetEquality,
  type RulesCelAndSetEqualitySubject,
} from '../../../../conformance/probes/firestore/firestore-rules-cel-expressions-and-set-equality.ts';
import { expectReplay, load } from './support.ts';

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

describe('Firestore query-proof and security-rules oracle captures (in-page pyric/firestore)', () => {
  it('firestore-query-proof-and-read-rules (firestore#24a, #24b, #139, #139a)', async () => {
    const production = load('firestore-query-proof-and-read-rules');
    const runId = 'inpage_qp';
    const basePath = `__pyric_fs_probe/${runId}`;
    const clientUid = 'alice_qp';
    const sandbox = initializeSandbox({ projectId: 'demo-rules-qp' });
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

    try {
      const pyric = await observeFirestoreQueryProofAndReadRules(subject);
      expectReplay({ production, pyric, pins: [] });
    } finally {
      sandbox.dispose();
    }
  });

  it('firestore-rules-write-and-cross-doc-verdicts (firestore#128..#132, #137)', async () => {
    const production = load('firestore-rules-write-and-cross-doc-verdicts');
    const runId = 'inpage_wc';
    const basePath = `__pyric_fs_probe/${runId}`;
    const plainUid = 'bob_wc';
    const sandbox = initializeSandbox({ projectId: 'demo-rules-wc' });
    setRules(sandbox, wrapRulesBlock(buildWriteAndCrossDocRulesBlock(runId)));
    const prefixedSeeds: Record<string, Record<string, unknown>> = {};
    for (const [rel, data] of Object.entries(seedDataForWriteAndCrossDoc(plainUid))) {
      prefixedSeeds[`${basePath}/${rel}`] = data;
    }
    seedDocuments(sandbox, prefixedSeeds);

    const unauthedDb = getFirestore(sandbox.withAuth(null));
    const plainDb = getFirestore(sandbox.withAuth({ uid: plainUid }));
    const claimedDb = getFirestore(
      sandbox.withAuth({ uid: 'editor_inpage', token: { role: 'editor', tier: 2 } }),
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

    try {
      const pyric = await observeFirestoreRulesWriteAndCrossDoc(subject, plainUid);
      expectReplay({ production, pyric, pins: [] });
    } finally {
      sandbox.dispose();
    }
  });

  it('firestore-rules-cel-expressions-and-set-equality (firestore#133..#136b, #138)', async () => {
    const production = load('firestore-rules-cel-expressions-and-set-equality');
    const runId = 'inpage_cel';
    const basePath = `__pyric_fs_probe/${runId}`;
    const sandbox = initializeSandbox({ projectId: 'demo-rules-cel' });
    setRules(sandbox, wrapRulesBlock(buildCelAndSetEqualityRulesBlock(runId)));
    const prefixedSeeds: Record<string, Record<string, unknown>> = {};
    for (const [rel, data] of Object.entries(seedDataForCelAndSetEquality())) {
      prefixedSeeds[`${basePath}/${rel}`] = data;
    }
    seedDocuments(sandbox, prefixedSeeds);

    const db = getFirestore(sandbox.withAuth({ uid: 'cel_reader' }));
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

    try {
      const pyric = await observeFirestoreRulesCelAndSetEquality(subject);
      expectReplay({
        production,
        pyric,
        pins: [
          {
            key: 'createVerdicts',
            finding:
              'packages/rules/src/simulator/evaluator.ts:512 models firebaserules:test (firestore-rules#188) where resource on create throws null-error -> deny, whereas live cloud.firestore setDoc create evaluates resource == null as true',
            production: {
              requestResourceFloatAllowed: 'allowed',
              requestResourceIntDenied: 'error:permission-denied',
              resourceEqNullOnCreateDenied: 'allowed',
              readingResourceDataOnCreateDenied: 'error:permission-denied',
            },
            pyric: {
              requestResourceFloatAllowed: 'allowed',
              requestResourceIntDenied: 'error:permission-denied',
              resourceEqNullOnCreateDenied: 'error:permission-denied',
              readingResourceDataOnCreateDenied: 'error:permission-denied',
            },
          },
        ],
      });
    } finally {
      sandbox.dispose();
    }
  });
});
