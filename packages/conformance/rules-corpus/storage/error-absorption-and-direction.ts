/**
 * ─── Scenario: error-absorption-and-direction ────────────────────────────────
 * CEL's && is a COMMUTATIVE error-absorbing operator in Storage rules, same as
 * the captured Firestore truth (RULES-B3): `error && false` evaluates cleanly
 * to false, because the determining operand absorbs the error, while
 * `error && true` propagates the error and denies. Top-level `error && false`
 * denies either way, so every distinguishing case CONSUMES the absorbed result
 * (negation or ==) to separate clean-false from error. The && direction was
 * never captured for Storage before this scenario (row #119 pins only
 * `error || true`).
 * Error generator: division by zero, per the ternary-and-error-absorption idiom.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-P4-ERROR-ABSORPTION',
  rationale:
    'Storage && absorbs commutatively like Firestore: !(error && false) allows; (error && false) == false allows; error && true and true && error propagate to DENY.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // error && false → false (absorbed); negation consumes it → ALLOW
    match /notErrAndFalse/{fileId} {
      allow read: if !((1 / 0 == 0) && false);
    }
    // absorbed result compared: (error && false) == false → ALLOW
    match /eqErrAndFalse/{fileId} {
      allow read: if ((1 / 0 == 0) && false) == false;
    }
    // JS-compatible direction as control: !(false && error) → ALLOW
    match /notFalseAndErr/{fileId} {
      allow read: if !(false && (1 / 0 == 0));
    }
    // error && true → error propagates → DENY (nothing determines)
    match /errAndTrueDeny/{fileId} {
      allow read: if ((1 / 0 == 0) && true) || false;
    }
    // true && error → error propagates → DENY (commutative twin)
    match /trueAndErrDeny/{fileId} {
      allow read: if (true && (1 / 0 == 0)) || false;
    }
    // || direction consumed: (error || true) == true → ALLOW
    match /eqErrOrTrue/{fileId} {
      allow read: if ((1 / 0 == 0) || true) == true;
    }
  }
}`,
  cases: [
    {
      description: '!(error && false) → absorbed to false, negated → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'notErrAndFalse/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: '(error && false) == false → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'eqErrAndFalse/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: '!(false && error) → short-circuit control → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'notFalseAndErr/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: 'error && true → propagates → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'errAndTrueDeny/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: 'true && error → propagates → DENY (commutative twin)',
      expectation: 'DENY',
      method: 'get',
      path: 'trueAndErrDeny/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
    {
      description: '(error || true) == true → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'eqErrOrTrue/a.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    },
  ],
};
