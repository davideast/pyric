/**
 * ─── Scenario: strict-boolean-allow-and-ternary ──────────────────────────────
 * CEL types the top-level `allow` boundary and the ternary CONDITION as bool.
 * A non-boolean in either position is an evaluation error, not a truthiness
 * coercion. The Firestore engine already has this captured
 * (rules-firestore-strict-boolean-control-flow); the Storage engine does not,
 * and this scenario is the capture that would settle it.
 *
 * A bare non-boolean allow condition denies either way, so the ternary cases
 * CONSUME the error (absorbed by `|| true`, and by `&& false` under negation)
 * to separate a type error from a plain false.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-P4-STRICT-BOOLEAN',
  rationale:
    'Storage types the allow boundary and the ternary condition as bool like Firestore: a non-boolean allow condition denies, and a non-boolean ternary condition errors, which || true and !(… && false) both consume as ALLOW.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // A string at the top-level allow boundary is a type error, not a
    // truthy value → DENY.
    match /nonBooleanAllow/{fileId} {
      allow read: if request.auth.uid;
    }
    // An int ternary condition errors; || true absorbs it → ALLOW.
    match /ternaryAbsorbedByOr/{fileId} {
      allow read: if (1 ? true : false) || true;
    }
    // The same error absorbed by && false, consumed by negation → ALLOW.
    match /ternaryAbsorbedByAnd/{fileId} {
      allow read: if !((1 ? true : false) && false);
    }
    // Boolean control: a bool condition selects a branch normally.
    match /booleanTernary/{fileId} {
      allow read: if request.auth != null ? true : false;
    }
  }
}`,
  cases: [
    {
      description: 'string allow condition is a type error → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'nonBooleanAllow/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: 'int ternary condition errors, absorbed by || true → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'ternaryAbsorbedByOr/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: 'int ternary condition errors, absorbed by && false and negated → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'ternaryAbsorbedByAnd/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: 'bool ternary condition selects the true branch → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'booleanTernary/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: 'anonymous read does not reach the true branch → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'booleanTernary/a.txt',
      existingResource: { size: 1 },
    },
  ],
};
