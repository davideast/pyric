/**
 * ─── Scenario 7: resource-timestamp-witness (KNOWN GAP) ─────────────────────────
 * The evaluator's resource model carries only size/contentType/metadata, so
 * resource.timeCreated / resource.updated read `undefined` and any comparison
 * DENIES in-process, while production evaluates a real server timestamp. These
 * cases are the witness for that gap: their `knownGap` marker tells the replay
 * suite to RECORD but NOT ASSERT the evaluator verdict (mirroring how the
 * Firestore replay skips its simulator's UNSUPPORTED abstentions). The
 * `expectation` is production's expected verdict, and stays UNVERIFIED until
 * capture confirms it — at which point this scenario is the evidence the field is
 * still unsupported in the evaluator.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-RES-TS',
  rationale:
    'Witness: resource.timeCreated / resource.updated are production Storage fields the evaluator does not model (reads undefined → deny) — records the known gap.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /created/{fileId} {
      allow get: if resource.timeCreated < request.time;
    }
    match /updated/{fileId} {
      allow get: if resource.updated < request.time;
    }
  }
}`,
  cases: [
    {
      description: 'resource.timeCreated < request.time (prod: real timestamp)',
      expectation: 'ALLOW', method: 'get', path: 'created/a.txt', existingResource: { size: 10 }, requestTime: '2025-06-01T00:00:00Z',
      knownGap: 'resource.timeCreated is not modeled by the evaluator (reads undefined → deny)',
    },
    {
      description: 'resource.updated < request.time (prod: real timestamp)',
      expectation: 'ALLOW', method: 'get', path: 'updated/b.txt', existingResource: { size: 10 }, requestTime: '2025-06-01T00:00:00Z',
      knownGap: 'resource.updated is not modeled by the evaluator (reads undefined → deny)',
    },
  ],
};
