/**
 * ─── Pack 4: cross-type-operator-overloads ────────────────────────────────
 * Targets Item 2 of the rebuild plan — operator overloads in
 * `evaluateBinaryOp` for Timestamp/Duration cross-type arithmetic. Pre-fix
 * (before Item 1.2/1.3), the namespace constructors returned bare epoch-ms
 * Numbers, so `Timestamp + Duration` was silent numeric add and the
 * resulting "Timestamp" lost its type identity. Production evaluates the
 * type-preserving cases natively. This pack proves the simulator now
 * matches across all four cross-type arithmetic forms plus `<` `>`
 * comparisons that depend on the wrappers' field-wise compareTo (not
 * numeric coercion).
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'Item 2',
  rationale: 'Wrapper binaryOp must produce typed results for Timestamp/Duration cross-type ops; numeric coercion would silently lose type identity and (post-Risk 2 guard) silently DENY.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Timestamp + Duration → Timestamp
    match /tsPlusDurAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(0) + duration.value(60, 's') == timestamp.value(60000);
    }
    // Timestamp - Duration → Timestamp
    match /tsMinusDurAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(60000) - duration.value(60, 's') == timestamp.value(0);
    }
    // Timestamp - Timestamp → Duration
    match /tsMinusTsAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(60000) - timestamp.value(0) == duration.value(60, 's');
    }
    // Duration + Duration → Duration
    match /durPlusDurAllow/{id} {
      allow create: if request.auth != null
        && duration.value(30, 's') + duration.value(30, 's') == duration.value(60, 's');
    }
    // Duration - Duration → Duration
    match /durMinusDurAllow/{id} {
      allow create: if request.auth != null
        && duration.value(60, 's') - duration.value(30, 's') == duration.value(30, 's');
    }
    // Timestamp comparison via field-wise compareTo (not numeric coercion)
    match /tsLessThanAllow/{id} {
      allow create: if request.auth != null
        && timestamp.date(2025, 1, 1) < timestamp.date(2099, 1, 1);
    }
    // DENY witness — wrong arithmetic should still fail
    match /tsPlusDurDeny/{id} {
      allow create: if request.auth != null
        && timestamp.value(0) + duration.value(60, 's') == timestamp.value(0);
    }
  }
}`,
  cases: [
    {
      description: 'Timestamp + Duration → Timestamp ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsPlusDurAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp - Duration → Timestamp ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsMinusDurAllow/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp - Timestamp → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsMinusTsAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Duration + Duration → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'durPlusDurAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Duration - Duration → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'durMinusDurAllow/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp < Timestamp via field compare ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsLessThanAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'wrong arithmetic — Timestamp + Duration ≠ original Timestamp DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'tsPlusDurDeny/d7',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
  ],
  group: 'stress',
};
