import { describe, it } from 'bun:test';
import type { QueryConstraint } from 'pyric/firestore';
import {
  buildQueryProofRulesBlock,
  observeFirestoreQueryProofAndReadRules,
  seedDataForQueryProof,
  type QueryProofReadRulesSubject,
} from '../../../../../conformance/probes/firestore/firestore-query-proof-and-read-rules.ts';
import {
  buildWriteAndCrossDocRulesBlock,
  observeFirestoreRulesWriteAndCrossDoc,
  seedDataForWriteAndCrossDoc,
  type ProbeClientKind,
  type RulesWriteAndCrossDocSubject,
} from '../../../../../conformance/probes/firestore/firestore-rules-write-and-cross-doc-verdicts.ts';
import {
  buildCelAndSetEqualityRulesBlock,
  observeFirestoreRulesCelAndSetEquality,
  seedDataForCelAndSetEquality,
  type RulesCelAndSetEqualitySubject,
} from '../../../../../conformance/probes/firestore/firestore-rules-cel-expressions-and-set-equality.ts';
import {
  createServedRulesReplaySession,
  type ServedPlaneKind,
} from './firestore-rules-and-query-proof-support.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

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

restoreSharedWorker();

for (const plane of ['SharedWorker', 'Node host'] as const satisfies readonly ServedPlaneKind[]) {
  describe(`Firestore query-proof and security-rules oracle captures (served ${plane})`, () => {
    it(`firestore-query-proof-and-read-rules, served ${plane}`, async () => {
      const production = load('firestore-query-proof-and-read-rules');
      const runId = 'served_qp';
      const basePath = `__pyric_fs_probe/${runId}`;
      const clientUid = 'alice_served';
      const prefixedSeeds: Record<string, Record<string, unknown>> = {};
      for (const [rel, data] of Object.entries(seedDataForQueryProof(clientUid))) {
        prefixedSeeds[`${basePath}/${rel}`] = data;
      }

      const session = await createServedRulesReplaySession(
        plane,
        wrapRulesBlock(buildQueryProofRulesBlock(runId)),
        prefixedSeeds,
      );
      try {
        const authedDb = await session.openClient({ uid: clientUid });
        const unauthedDb = await session.openClient();
        const w = session.worker;
        const dbFor = (authed: boolean) => {
          if (authed) return authedDb;
          return unauthedDb;
        };

        const subject: QueryProofReadRulesSubject = {
          clientUid,
          async readDocOutcome(relPath, authed) {
            try {
              await w.getDoc(w.doc(dbFor(authed), `${basePath}/${relPath}`));
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
          async queryIdsOrError(relCollection, opts) {
            try {
              const col = w.collection(dbFor(opts.authed), `${basePath}/${relCollection}`);
              const constraints: QueryConstraint[] = [];
              if (opts.whereEqual !== undefined) {
                constraints.push(w.where(opts.whereEqual.field, '==', opts.whereEqual.value));
              }
              if (opts.limitCount !== undefined) {
                constraints.push(w.limit(opts.limitCount));
              }
              const snap = await w.getDocs(w.query(col, ...constraints));
              return { ok: true, ids: snap.docs.map((d) => d.id).sort() };
            } catch (err) {
              return { ok: false, code: errorCodeOf(err) };
            }
          },
          async countOrError(relCollection, opts) {
            try {
              const col = w.collection(dbFor(opts.authed), `${basePath}/${relCollection}`);
              const constraints: QueryConstraint[] = [];
              if (opts.whereEqual !== undefined) {
                constraints.push(w.where(opts.whereEqual.field, '==', opts.whereEqual.value));
              }
              const snap = await w.getCountFromServer(w.query(col, ...constraints));
              return { ok: true, count: snap.data().count };
            } catch (err) {
              return { ok: false, code: errorCodeOf(err) };
            }
          },
          async firstSnapshotIdsOrError(relCollection, whereEqual) {
            const col = w.collection(authedDb, `${basePath}/${relCollection}`);
            const constraints: QueryConstraint[] = [];
            if (whereEqual !== undefined) {
              constraints.push(w.where(whereEqual.field, '==', whereEqual.value));
            }
            return new Promise((resolve) => {
              let stop: () => void = () => {};
              stop = w.onSnapshot(
                w.query(col, ...constraints),
                (snap) => {
                  stop();
                  const docs = (snap as { docs: Array<{ id: string }> }).docs;
                  resolve({ ok: true, ids: docs.map((d) => d.id).sort() });
                },
                (err) => {
                  stop();
                  resolve({ ok: false, code: errorCodeOf(err) });
                },
              );
            });
          },
        };

        const pyric = await observeFirestoreQueryProofAndReadRules(subject);
        expectReplay({ production, pyric, pins: [] });
      } finally {
        await session.cleanup();
      }
    });

    it(`firestore-rules-write-and-cross-doc-verdicts, served ${plane}`, async () => {
      const production = load('firestore-rules-write-and-cross-doc-verdicts');
      const runId = 'served_wc';
      const basePath = `__pyric_fs_probe/${runId}`;
      const plainUid = 'bob_served';
      const prefixedSeeds: Record<string, Record<string, unknown>> = {};
      for (const [rel, data] of Object.entries(seedDataForWriteAndCrossDoc(plainUid))) {
        prefixedSeeds[`${basePath}/${rel}`] = data;
      }

      const session = await createServedRulesReplaySession(
        plane,
        wrapRulesBlock(buildWriteAndCrossDocRulesBlock(runId)),
        prefixedSeeds,
      );
      try {
        const unauthedDb = await session.openClient();
        const plainDb = await session.openClient({ uid: plainUid });
        const claimedDb = await session.openClient({
          uid: 'editor_served',
          claims: { role: 'editor', tier: 2 },
        });
        const w = session.worker;
        const dbFor = (kind: ProbeClientKind) => {
          if (kind === 'claimed') return claimedDb;
          if (kind === 'plain') return plainDb;
          return unauthedDb;
        };

        const subject: RulesWriteAndCrossDocSubject = {
          async readOutcome(kind, relPath) {
            try {
              await w.getDoc(w.doc(dbFor(kind), `${basePath}/${relPath}`));
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
          async setOutcome(kind, relPath, data) {
            try {
              await w.setDoc(w.doc(dbFor(kind), `${basePath}/${relPath}`), data);
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
          async updateOutcome(kind, relPath, data) {
            try {
              await w.updateDoc(w.doc(dbFor(kind), `${basePath}/${relPath}`), data);
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
        };

        const pyric = await observeFirestoreRulesWriteAndCrossDoc(subject, plainUid);
        expectReplay({ production, pyric, pins: [] });
      } finally {
        await session.cleanup();
      }
    });

    it(`firestore-rules-cel-expressions-and-set-equality, served ${plane}`, async () => {
      const production = load('firestore-rules-cel-expressions-and-set-equality');
      const runId = 'served_cel';
      const basePath = `__pyric_fs_probe/${runId}`;
      const prefixedSeeds: Record<string, Record<string, unknown>> = {};
      for (const [rel, data] of Object.entries(seedDataForCelAndSetEquality())) {
        prefixedSeeds[`${basePath}/${rel}`] = data;
      }

      const session = await createServedRulesReplaySession(
        plane,
        wrapRulesBlock(buildCelAndSetEqualityRulesBlock(runId)),
        prefixedSeeds,
      );
      try {
        const db = await session.openClient({ uid: 'cel_served_reader' });
        const w = session.worker;

        const subject: RulesCelAndSetEqualitySubject = {
          async readOutcome(relPath) {
            try {
              await w.getDoc(w.doc(db, `${basePath}/${relPath}`));
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
          async setOutcome(relPath, data) {
            try {
              await w.setDoc(w.doc(db, `${basePath}/${relPath}`), data);
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
          async updateOutcome(relPath, data) {
            try {
              await w.updateDoc(w.doc(db, `${basePath}/${relPath}`), data);
              return 'allowed';
            } catch (err) {
              return `error:${errorCodeOf(err)}`;
            }
          },
        };

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
        await session.cleanup();
      }
    });
  });
}
