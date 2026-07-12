/**
 * ─── Scenario 5: prototype-chain-keys (RULES-B7) ──────────────────────────────
 * Production maps expose OWN keys only — `'toString' in data` is false
 * unless the document literally has a `toString` field, and
 * `data.constructor` is a missing-field error. Pre-fix the simulator's
 * `in` walked the JS prototype chain, so `'toString' in data` allowed and
 * `data.constructor` returned the Object constructor.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B7',
  rationale: "`'toString' in map` must be false (own keys only) and `.constructor` access must error; JS prototype-chain leakage said true / returned Object.",
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // proto method name is NOT a key → false → DENY
    match /protoInDeny/{id} {
      allow create: if 'toString' in request.resource.data;
    }
    // negated form → ALLOW
    match /protoNotInAllow/{id} {
      allow create: if !('toString' in request.resource.data)
        && !('constructor' in request.resource.data)
        && !('hasOwnProperty' in request.resource.data);
    }
    // a REAL field named toString IS a key → ALLOW
    match /realKeyInAllow/{id} {
      allow create: if 'toString' in request.resource.data
        && request.resource.data.toString == 'present';
    }
    // .constructor access on a map without that field → error → DENY
    match /constructorAccessDeny/{id} {
      allow create: if request.resource.data.constructor != null;
    }
    // keys() reflects own keys only → ALLOW
    match /keysOwnOnlyAllow/{id} {
      allow create: if !request.resource.data.keys().hasAny(['toString', 'constructor'])
        && request.resource.data.keys().hasOnly(['name']);
    }
  }
}`,
  cases: [
    {
      description: "'toString' in data (no such field) → DENY",
      expectation: 'DENY',
      method: 'create',
      path: 'protoInDeny/d1',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'no proto names leak into `in` → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'protoNotInAllow/d2',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: "literal field named 'toString' IS a key → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'realKeyInAllow/d3',
      auth: { uid: 'alice' },
      data: { toString: 'present' },
    },
    {
      description: '.constructor access (no such field) → DENY (error)',
      expectation: 'DENY',
      method: 'create',
      path: 'constructorAccessDeny/d4',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'keys() lists own keys only → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'keysOwnOnlyAllow/d5',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
  ],
  group: 'fix-class',
};
