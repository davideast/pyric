/**
 * ─── Pack 1: error-absorption-and-or (RULES-B3) ───────────────────────────
 * CEL's && and || are COMMUTATIVE error-absorbing operators: `error || true`
 * is true (the true branch absorbs the error), `error && false` is false,
 * while `error || false` / `error && true` propagate the error → DENY.
 * Pre-fix the simulator short-circuited left-to-right JS-style, so
 * `error || true` denied where production allows. The error generator here
 * is a missing-field access (a runtime error post-RULES-B2).
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'RULES-B3',
  rationale: 'CEL tri-state: `error || true` → ALLOW, `error && false` → DENY-as-false; errors absorb commutatively, not JS left-to-right.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // error || true → true (absorbed) → ALLOW
    match /errOrTrueAllow/{id} {
      allow create: if request.resource.data.missing > 0 || true;
    }
    // true || error → true → ALLOW (JS-compatible direction, control)
    match /trueOrErrAllow/{id} {
      allow create: if true || request.resource.data.missing > 0;
    }
    // error || false → error propagates → DENY
    match /errOrFalseDeny/{id} {
      allow create: if request.resource.data.missing > 0 || false;
    }
    // error && false → false (absorbed) → DENY (as false, not error)
    match /errAndFalseDeny/{id} {
      allow create: if request.resource.data.missing > 0 && false;
    }
    // false && error → false → DENY (JS-compatible direction, control)
    match /falseAndErrDeny/{id} {
      allow create: if false && request.resource.data.missing > 0;
    }
    // error && true → error propagates → DENY
    match /errAndTrueDeny/{id} {
      allow create: if request.resource.data.missing > 0 && true;
    }
    // absorbed-error result feeds an outer || → ALLOW
    match /nestedAbsorbAllow/{id} {
      allow create: if (request.resource.data.missing > 0 && false) || true;
    }
  }
}`,
  cases: [
    {
      description: 'error || true → ALLOW (commutative absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'errOrTrueAllow/d1',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'true || error → ALLOW (short-circuit control)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'trueOrErrAllow/d2',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'error || false → DENY (error propagates)',
      expectation: 'DENY',
      method: 'create',
      path: 'errOrFalseDeny/d3',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'error && false → DENY (absorbed to false)',
      expectation: 'DENY',
      method: 'create',
      path: 'errAndFalseDeny/d4',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'false && error → DENY (short-circuit control)',
      expectation: 'DENY',
      method: 'create',
      path: 'falseAndErrDeny/d5',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'error && true → DENY (error propagates)',
      expectation: 'DENY',
      method: 'create',
      path: 'errAndTrueDeny/d6',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: '(error && false) || true → ALLOW (nested absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'nestedAbsorbAllow/d7',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
  ],
  group: 'fix-class',
};
