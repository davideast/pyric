/**
 * ─── Pack 2: undefined-field-access (RULES-B2) ────────────────────────────
 * Production: reading a key that does not exist on a map is a runtime ERROR
 * (→ deny via tri-state), NOT a silent null. Pre-fix the simulator returned
 * null, which INVERTED the commonest rules-debug idiom:
 * `request.resource.data.typo == null` allowed in sim, denies in prod.
 * The correct absence check is the `in` operator.
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'RULES-B2',
  rationale: 'Missing-field access is a runtime error in prod (deny), not null; `typo == null` must DENY and `!(key in map)` is the real absence check.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // The inverted-idiom witness: missing field compared to null → error → DENY
    match /typoEqNullDeny/{id} {
      allow create: if request.resource.data.typo == null;
    }
    // Present-field control → ALLOW
    match /presentEqAllow/{id} {
      allow create: if request.resource.data.name == 'alice';
    }
    // Correct absence check via the "in" operator → ALLOW
    match /notInAllow/{id} {
      allow create: if !('typo' in request.resource.data);
    }
    // Nested missing field under an existing map → error → DENY
    match /nestedTypoDeny/{id} {
      allow create: if request.resource.data.m.typo == 'x';
    }
    // Error propagates through unary ! (no boolean coercion) → DENY
    match /negatedErrorDeny/{id} {
      allow create: if !(request.resource.data.typo == 'x');
    }
    // Missing-field error absorbed by || true (RULES-B3 interplay) → ALLOW
    match /absorbedAllow/{id} {
      allow create: if request.resource.data.typo == 'x' || true;
    }
  }
}`,
  cases: [
    {
      description: 'missing field == null → DENY (error, not null)',
      expectation: 'DENY',
      method: 'create',
      path: 'typoEqNullDeny/d1',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'present field == value → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'presentEqAllow/d2',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: "!('typo' in data) → ALLOW (correct absence check)",
      expectation: 'ALLOW',
      method: 'create',
      path: 'notInAllow/d3',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'nested missing field under existing map → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nestedTypoDeny/d4',
      auth: { uid: 'alice' },
      data: { m: { a: 1 } },
    },
    {
      description: '!(missing == value) → DENY (error propagates through !)',
      expectation: 'DENY',
      method: 'create',
      path: 'negatedErrorDeny/d5',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'missing-field error || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'absorbedAllow/d6',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
  ],
  group: 'fix-class',
};
