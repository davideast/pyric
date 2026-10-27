/**
 * ─── Candidate scenario (hunt H1, ST-H1-10): h1-lookup-interpolated-slash ────
 * A `$(...)` interpolation whose value contains `/`, inside a
 * firestore.get()/exists() path. pyric splices the value into several path
 * segments (rules-firestore-lookup.ts buildFirestoreDocPath joins with `/`),
 * so `users/$(uid)` with uid = 'alice/private/x' reads document
 * users/alice/private/x. If production keeps the value as one segment (or
 * escapes it), the mocked deeper document is never read and the request
 * denies. The capture's diagnostics.api.functionCalls[].args record the exact
 * path production built, which settles it either way.
 */
import type { StorageScenarioRecord } from './types.ts';

const deep = { function: 'get' as const, path: 'users/alice/private/x', result: { admin: true } };
const deepExists = { function: 'exists' as const, path: 'users/alice/private/x', result: true };

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-LOOKUP-SLASH',
  rationale: 'An interpolated value containing a slash may select a different document than the rule author wrote.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /lk/get.bin {
      allow create: if firestore.get(/databases/(default)/documents/users/$(request.resource.metadata.uid)).data.admin == true;
    }
    match /lk/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/users/$(request.resource.metadata.uid));
    }
    match /lk/control.bin {
      allow create: if firestore.get(/databases/(default)/documents/users/alice/private/x).data.admin == true;
    }
  }
}`,
  cases: [
    { description: 'get: interpolated value with slashes reads the deeper document (pyric ALLOW)', expectation: 'DENY', method: 'create', path: 'lk/get.bin', auth: { uid: 'alice' }, resource: { size: 1, metadata: { uid: 'alice/private/x' } }, functionMocks: [deep] },
    { description: 'exists: interpolated value with slashes finds the deeper document (pyric ALLOW)', expectation: 'DENY', method: 'create', path: 'lk/exists.bin', auth: { uid: 'alice' }, resource: { size: 1, metadata: { uid: 'alice/private/x' } }, functionMocks: [deepExists] },
    { description: 'control: literal deeper path reads the mock (pyric ALLOW)', expectation: 'ALLOW', method: 'create', path: 'lk/control.bin', auth: { uid: 'alice' }, resource: { size: 1 }, functionMocks: [deep] },
  ],
};
