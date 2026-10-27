/**
 * H2 candidate (ST-H2-9, NEEDS_RUNTIME_MRE). Interpolating a recursive
 * wildcard capture (a `path` value since ST-SIM-7) into a firestore.exists()
 * path. pyric throws "Firestore path interpolation resolved to path (expected
 * a string)" and denies every case. The mocks name the document each case
 * would read if production splices the path's segments in.
 *
 * pyric decides: DENY for all four cases.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H2-LOOKUP-PATH-INTERPOLATION',
  rationale: 'Whether $(pathValue) in a firestore.exists() path splices the path segments, errors, or stringifies.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /one/{rest=**} {
      allow create: if firestore.exists(/databases/(default)/documents/col/$(rest));
    }
    match /str/{rest=**} {
      allow create: if firestore.exists(/databases/(default)/documents/col/$(string(rest)));
    }
  }
}`,
  cases: [
    { description: 'single-segment path capture interpolates', expectation: 'ALLOW', method: 'create', path: 'one/a', resource: { size: 1 }, functionMocks: [{ function: 'exists', path: 'col/a', result: true }] },
    { description: 'three-segment path capture interpolates to a deeper document', expectation: 'ALLOW', method: 'create', path: 'one/a/b/c', resource: { size: 1 }, functionMocks: [{ function: 'exists', path: 'col/a/b/c', result: true }] },
    { description: 'string() of a single-segment capture interpolates', expectation: 'ALLOW', method: 'create', path: 'str/a', resource: { size: 1 }, functionMocks: [{ function: 'exists', path: 'col/a', result: true }] },
    { description: 'string() of a two-segment capture', expectation: 'ALLOW', method: 'create', path: 'str/a/b', resource: { size: 1 }, functionMocks: [{ function: 'exists', path: 'col/a/b', result: true }] },
  ],
};
