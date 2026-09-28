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
 *
 * Allow rules after an error, as in the Firestore scenario
 * error-absorption-and-or: a later allow rule, in the same match block or in
 * another block that matches the path, is still evaluated and can grant, and
 * a limit reached after the error is reported as the earlier error.
 *
 * Operands after an error, as in the Firestore scenario: production
 * evaluates every operand of a non-logical operator, list elements, and a
 * method call's receiver and arguments after one errors, and reports the
 * first error in evaluation order; `in` evaluates its collection before its
 * element. The diagnostics name which of two missing properties was
 * reported. A limit reached by an operand after the error, in the same
 * expression, is reported as the limit. An int division or modulo by a zero
 * read from the request is "Divide by zero error.".
 */
import type { StorageScenarioRecord } from './types.ts';

/** `overLimit0()` is true and evaluates about 1220 expressions. */
const OVER_LIMIT_FUNCTIONS = Array.from({ length: 10 }, (_, i) => {
  const terms = Array.from({ length: 40 }, () => 'true');
  if (i < 9) terms.push(`overLimit${i + 1}()`);
  return `    function overLimit${i}() {\n      return ${terms.join(' && ')};\n    }`;
}).join('\n');

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
${OVER_LIMIT_FUNCTIONS}
    // Allow rules after an error.
    match /errThenTrueAllow/{fileId} {
      allow read: if (1 / 0 == 0);
      allow read: if true;
    }
    match /errThenFalseDeny/{fileId} {
      allow read: if (1 / 0 == 0);
      allow read: if false;
    }
    match /blocksErrThenTrueAllow/{fileId} {
      allow read: if (1 / 0 == 0);
    }
    match /blocksErrThenTrueAllow/{fileId} {
      allow read: if true;
    }
    match /errThenOverLimitDeny/{fileId} {
      allow read: if (1 / 0 == 0);
      allow read: if overLimit0();
    }
    // Division and modulo by a zero read from the request.
    match /divideByRequestZeroDeny/{fileId} {
      allow create: if 1 / request.resource.size == 1;
    }
    match /moduloByRequestZeroDeny/{fileId} {
      allow create: if 1 % request.resource.size == 1;
    }
    // Which of two errors is reported.
    match /firstErrorEq/{fileId} {
      allow create: if request.resource.missingA == request.resource.missingB;
    }
    match /firstErrorList/{fileId} {
      allow create: if [request.resource.missingA, request.resource.missingB] == [];
    }
    match /firstErrorIn/{fileId} {
      allow create: if request.resource.missingA in [request.resource.missingB];
    }
    match /firstErrorMethodArgs/{fileId} {
      allow create: if request.resource.metadata.get(request.resource.missingA, request.resource.missingB) == 1;
    }
    match /firstErrorReceiver/{fileId} {
      allow create: if request.resource.missingA.get(request.resource.missingB, 1) == 1;
    }
    // An operand past the limit after an error in the same expression.
    match /errThenOperandOverLimitDeny/{fileId} {
      allow create: if [request.resource.missing, overLimit0()] == [];
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
    ...([
      ['errThenTrueAllow', 'an error, then a true rule in the same block → ALLOW', 'ALLOW'],
      ['errThenFalseDeny', 'an error, then a false rule in the same block → DENY', 'DENY'],
      ['blocksErrThenTrueAllow', 'an error, then a true rule in a second matching block → ALLOW', 'ALLOW'],
      ['errThenOverLimitDeny', 'an error, then a true rule past the expression limit → DENY, reported as the error', 'DENY'],
    ] as const).map(([folder, description, expectation]) => ({
      description,
      expectation,
      method: 'get' as const,
      path: `${folder}/a.txt`,
      auth: { uid: 'alice' },
      existingResource: { size: 1 },
    })),
    ...([
      ['divideByRequestZeroDeny', 'int division by a zero from the request → DENY', 'DENY'],
      ['moduloByRequestZeroDeny', 'int modulo by a zero from the request → DENY', 'DENY'],
      ['firstErrorEq', 'two erroring operands of == → DENY, reported as the left one', 'DENY'],
      ['firstErrorList', 'two erroring list elements → DENY, reported as the first', 'DENY'],
      ['firstErrorIn', 'an erroring element and collection of in → DENY, reported as the collection', 'DENY'],
      ['firstErrorMethodArgs', 'two erroring method arguments → DENY, reported as the first', 'DENY'],
      ['firstErrorReceiver', 'an erroring receiver and argument → DENY, reported as the receiver', 'DENY'],
      ['errThenOperandOverLimitDeny', 'an error, then an operand past the expression limit in the same expression → DENY at the limit', 'DENY'],
    ] as const).map(([folder, description, expectation]) => ({
      description,
      expectation,
      method: 'create' as const,
      path: `${folder}/a.txt`,
      auth: { uid: 'alice' },
      resource: { size: 0, contentType: 'text/plain', metadata: { k: 'v' } },
    })),
  ],
};
