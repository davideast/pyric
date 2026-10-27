/**
 * ─── Candidate scenario (hunt H1, ST-H1-7): h1-auth-token-default ────────────
 * A case with `auth: { uid }` and no token goes over the wire as
 * `{ uid, token: {} }` (buildStorageApiTestCase), so production sees an empty
 * token map. The Storage evaluator (and the replay's toEvaluationInput, which
 * passes tc.auth through) sees no token at all and denies with "Property token
 * is undefined on object". The Firestore simulator defaults the token to {}.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-AUTH-TOKEN',
  rationale: 'An authenticated request always carries a token map on the wire; the Storage evaluator drops it when the case omits it.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /tok/is-map.bin { allow create: if request.auth.token is map; }
    match /tok/empty.bin { allow create: if request.auth.token.size() == 0; }
    match /tok/get-default.bin { allow create: if request.auth.token.get('admin', false) == false; }
  }
}`,
  cases: [
    { description: 'token is a map when the case gives none (pyric DENY)', expectation: 'ALLOW', method: 'create', path: 'tok/is-map.bin', auth: { uid: 'alice' }, resource: { size: 1 } },
    { description: 'token is empty when the case gives none (pyric DENY)', expectation: 'ALLOW', method: 'create', path: 'tok/empty.bin', auth: { uid: 'alice' }, resource: { size: 1 } },
    { description: 'token.get default when the case gives none (pyric DENY)', expectation: 'ALLOW', method: 'create', path: 'tok/get-default.bin', auth: { uid: 'alice' }, resource: { size: 1 } },
    { description: 'control: explicit token map (pyric ALLOW)', expectation: 'ALLOW', method: 'create', path: 'tok/is-map.bin', auth: { uid: 'alice', token: { admin: false } }, resource: { size: 1 } },
  ],
};
