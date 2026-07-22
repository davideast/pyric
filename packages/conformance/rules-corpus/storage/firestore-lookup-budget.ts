/**
 * P3 mocked cross-service discovery probe. Function mocks keep this entirely
 * inside the Rules Test API: no Firestore documents are created or read. The
 * cases distinguish raw call count from distinct-document budgeting and pin
 * short-circuit/ternary evaluation before any lookup helper is proposed.
 */
import type { StorageScenarioRecord } from './types.ts';

const getA = { function: 'get' as const, path: 'probe/a', result: { role: 'editor', nested: { enabled: true } } };
const existsA = { function: 'exists' as const, path: 'probe/a', result: true };
const existsB = { function: 'exists' as const, path: 'probe/b', result: true };
const existsC = { function: 'exists' as const, path: 'probe/c', result: true };

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-P3-LOOKUP-BUDGET',
  rationale:
    'Mocked firestore.get/exists return, error, caching, distinct-document budget, and lazy-evaluation behavior without touching a real Firestore database.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /one/{fileName} {
      allow create: if firestore.get(/databases/(default)/documents/probe/a).data.role == 'editor';
    }
    match /missing-field/{fileName} {
      allow create: if firestore.get(/databases/(default)/documents/probe/a).data.missing == true;
    }
    match /exists/{fileName} {
      allow create: if firestore.exists(/databases/(default)/documents/probe/a);
    }
    match /repeat/{fileName} {
      allow create: if firestore.exists(/databases/(default)/documents/probe/a)
        && firestore.exists(/databases/(default)/documents/probe/a)
        && firestore.exists(/databases/(default)/documents/probe/a);
    }
    match /two/{fileName} {
      allow create: if firestore.exists(/databases/(default)/documents/probe/a)
        && firestore.exists(/databases/(default)/documents/probe/b);
    }
    match /three/{fileName} {
      allow create: if firestore.exists(/databases/(default)/documents/probe/a)
        && firestore.exists(/databases/(default)/documents/probe/b)
        && firestore.exists(/databases/(default)/documents/probe/c);
    }
    match /get-exists-two-docs/{fileName} {
      allow create: if firestore.get(/databases/(default)/documents/probe/a).data.role == 'editor'
        && firestore.exists(/databases/(default)/documents/probe/a)
        && firestore.exists(/databases/(default)/documents/probe/b);
    }
    match /resolved-same-path/{userId}/{fileName} {
      allow create: if firestore.exists(/databases/(default)/documents/probe/alice)
        && firestore.exists(/databases/(default)/documents/probe/$(userId));
    }
    match /short-or/{fileName} {
      allow create: if true || firestore.exists(/databases/(default)/documents/probe/c);
    }
    match /short-and/{fileName} {
      allow create: if false && firestore.exists(/databases/(default)/documents/probe/c);
    }
    match /short-third/{fileName} {
      allow create: if firestore.exists(/databases/(default)/documents/probe/a)
        && firestore.exists(/databases/(default)/documents/probe/b)
        && (true || firestore.exists(/databases/(default)/documents/probe/c));
    }
    match /ternary/{fileName} {
      allow create: if request.auth != null
        ? firestore.exists(/databases/(default)/documents/probe/a)
        : firestore.exists(/databases/(default)/documents/probe/c);
    }
  }
}`,
  cases: [
    { description: 'get: existing mocked document field allows', expectation: 'ALLOW', method: 'create', path: 'one/a.bin', resource: { size: 1 }, functionMocks: [getA] },
    { description: 'get: missing mocked document field errors and denies', expectation: 'DENY', method: 'create', path: 'missing-field/a.bin', resource: { size: 1 }, functionMocks: [getA] },
    { description: 'exists: true mock allows', expectation: 'ALLOW', method: 'create', path: 'exists/a.bin', resource: { size: 1 }, functionMocks: [existsA] },
    { description: 'exists: false mock denies', expectation: 'DENY', method: 'create', path: 'exists/a.bin', resource: { size: 1 }, functionMocks: [{ function: 'exists', path: 'probe/a', result: false }] },
    { description: 'budget: three repeated calls to one document allow', expectation: 'ALLOW', method: 'create', path: 'repeat/a.bin', resource: { size: 1 }, functionMocks: [existsA] },
    { description: 'budget: two distinct documents allow', expectation: 'ALLOW', method: 'create', path: 'two/a.bin', resource: { size: 1 }, functionMocks: [existsA, existsB] },
    { description: 'budget: three distinct documents deny', expectation: 'DENY', method: 'create', path: 'three/a.bin', resource: { size: 1 }, functionMocks: [existsA, existsB, existsC] },
    { description: 'cache: get and exists same path plus second document allow', expectation: 'ALLOW', method: 'create', path: 'get-exists-two-docs/a.bin', resource: { size: 1 }, functionMocks: [getA, existsA, existsB] },
    { description: 'cache: literal and interpolated paths resolving identically allow', expectation: 'ALLOW', method: 'create', path: 'resolved-same-path/alice/a.bin', resource: { size: 1 }, functionMocks: [{ function: 'exists', path: 'probe/alice', result: true }] },
    { description: 'lazy OR: true left branch skips unmocked lookup and allows', expectation: 'ALLOW', method: 'create', path: 'short-or/a.bin', resource: { size: 1 } },
    { description: 'lazy AND: false left branch skips unmocked lookup and denies', expectation: 'DENY', method: 'create', path: 'short-and/a.bin', resource: { size: 1 } },
    { description: 'lazy budget: short-circuited third distinct lookup does not deny', expectation: 'ALLOW', method: 'create', path: 'short-third/a.bin', resource: { size: 1 }, functionMocks: [existsA, existsB] },
    { description: 'ternary: authenticated branch executes only first lookup', expectation: 'ALLOW', method: 'create', path: 'ternary/a.bin', auth: { uid: 'alice' }, resource: { size: 1 }, functionMocks: [existsA] },
    { description: 'ternary: anonymous branch executes only alternate lookup', expectation: 'ALLOW', method: 'create', path: 'ternary/a.bin', auth: null, resource: { size: 1 }, functionMocks: [existsC] },
  ],
};
