/**
 * ─── Scenario: xref-root-literal-bucket ──────────────────────────────────────
 * Cross-check of the Firestore finding that pyric never compares the literal
 * segments of the root match path with the request path. Here the root names
 * one bucket literally: a request in that bucket must match, and a request in
 * any other bucket must not, so its open grant cannot apply.
 */
import type { StorageScenarioRecord } from './types.ts';

const NAMED = 'demo-pyric.appspot.com';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-XREF-ROOT-LITERAL',
  rationale:
    'A root match that names its bucket literally grants only that bucket; a request in another bucket matches no rule and denies.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/${NAMED}/o {
    match /{f=**} { allow read, write: if true; }
  }
}`,
  cases: [
    { description: 'named bucket: get matches the literal root', expectation: 'ALLOW', method: 'get', path: 'a.bin', bucket: NAMED, existingResource: { size: 1 } },
    { description: 'named bucket: create matches the literal root', expectation: 'ALLOW', method: 'create', path: 'a.bin', bucket: NAMED, resource: { size: 1 } },
    { description: 'other bucket: get does not match the literal root', expectation: 'DENY', method: 'get', path: 'a.bin', bucket: 'other-bucket', existingResource: { size: 1 } },
    { description: 'other bucket: create does not match the literal root', expectation: 'DENY', method: 'create', path: 'a.bin', bucket: 'other-bucket', resource: { size: 1 } },
    { description: 'bucket name prefix: get in demo-pyric.appspot.com2 does not match', expectation: 'DENY', method: 'get', path: 'a.bin', bucket: 'demo-pyric.appspot.com2', existingResource: { size: 1 } },
  ],
};
