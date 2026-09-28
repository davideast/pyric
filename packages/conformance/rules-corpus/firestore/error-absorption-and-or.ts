/**
 * ─── Scenario 1: error-absorption-and-or (RULES-B3) ───────────────────────────
 * CEL's && and || are COMMUTATIVE error-absorbing operators: `error || true`
 * is true (the true branch absorbs the error), `error && false` is false,
 * while `error || false` / `error && true` propagate the error → DENY.
 * Pre-fix the simulator short-circuited left-to-right JS-style, so
 * `error || true` denied where production allows. The error generator here
 * is a missing-field access (a runtime error post-RULES-B2).
 *
 * Allow rules after an error: an allow rule that raises an error does not
 * end the request. The method's later allow rules, in the same match block
 * or in another block that matches the path, are still evaluated and one of
 * them can grant. Their expressions count toward the 1000-expression limit,
 * and a limit reached after the error is reported as the earlier error (the
 * over-limit cases' diagnostics). The error generator for these cases is
 * `[1] + [2] == [1, 2]`, an unsupported `list + list`.
 *
 * Errors passed into functions and `let` bindings: production binds an
 * argument or `let` value that errors and evaluates the function body. The
 * error decides the verdict only where the body reads it, so a function that
 * ignores the argument grants, also when the argument passes through a
 * second call. The error generator for these cases is an int division by
 * `request.resource.data.zero`, which is 0: "Divide by zero error.", for `%`
 * too.
 *
 * Operands after an error: production evaluates every operand of a
 * non-logical operator, list and map literal elements, and a method call's
 * receiver and arguments after one errors, and reports the first error in
 * evaluation order: the left operand of `==` and `+`, the first element, the
 * receiver, then the first argument. `in` evaluates its collection before
 * its element. The diagnostics name which of two missing fields was
 * reported. A limit reached by an operand after the error, in the same
 * expression, is reported as the limit.
 */
import type { ScenarioRecord } from './types.ts';

const LIST_PLUS_LIST = '[1] + [2] == [1, 2]';

/** A zero the request carries, so the division errors at evaluation. */
const ZERO = 'request.resource.data.zero';

/**
 * `overLimit0()` is true and evaluates about 1220 expressions: ten functions
 * of 40 `true` conjuncts, each calling the next from its last conjunct.
 */
const OVER_LIMIT_FUNCTIONS = Array.from({ length: 10 }, (_, i) => {
  const terms = Array.from({ length: 40 }, () => 'true');
  if (i < 9) terms.push(`overLimit${i + 1}()`);
  return `    function overLimit${i}() {\n      return ${terms.join(' && ')};\n    }`;
}).join('\n');

export const scenario: ScenarioRecord = {
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
${OVER_LIMIT_FUNCTIONS}
    // Allow rules after an error, in one match block.
    match /errThenTrueAllow/{id} {
      allow create: if ${LIST_PLUS_LIST};
      allow create: if true;
    }
    match /errThenFalseDeny/{id} {
      allow create: if ${LIST_PLUS_LIST};
      allow create: if false;
    }
    match /trueThenErrAllow/{id} {
      allow create: if true;
      allow create: if ${LIST_PLUS_LIST};
    }
    match /falseThenErrDeny/{id} {
      allow create: if false;
      allow create: if ${LIST_PLUS_LIST};
    }
    // The same shapes across two match blocks that both match the path.
    match /blocksErrThenTrueAllow/{id} {
      allow create: if ${LIST_PLUS_LIST};
    }
    match /blocksErrThenTrueAllow/{id} {
      allow create: if true;
    }
    match /blocksErrThenFalseDeny/{id} {
      allow create: if ${LIST_PLUS_LIST};
    }
    match /blocksErrThenFalseDeny/{id} {
      allow create: if false;
    }
    match /blocksTrueThenErrAllow/{id} {
      allow create: if true;
    }
    match /blocksTrueThenErrAllow/{id} {
      allow create: if ${LIST_PLUS_LIST};
    }
    match /blocksFalseThenErrDeny/{id} {
      allow create: if false;
    }
    match /blocksFalseThenErrDeny/{id} {
      allow create: if ${LIST_PLUS_LIST};
    }
    // A true rule past the limit after an error, and after a false rule.
    match /errThenOverLimitDeny/{id} {
      allow create: if ${LIST_PLUS_LIST};
      allow create: if overLimit0();
    }
    match /falseThenOverLimitDeny/{id} {
      allow create: if false;
      allow create: if overLimit0();
    }
    // Errors passed into functions and let bindings.
    function ignoresArg(a) { return true; }
    function readsArg(a) { return a > 0; }
    function passesToIgnoresArg(a) { return ignoresArg(a); }
    function passesToReadsArg(a) { return readsArg(a); }
    function readsSecondArg(a, b) { return b; }
    function letUnread() { let x = 1 / ${ZERO}; return true; }
    function letRead() { let x = 1 / ${ZERO}; return x > 0; }
    match /argUnreadAllow/{id} {
      allow create: if ignoresArg(1 / ${ZERO});
    }
    match /argReadDeny/{id} {
      allow create: if readsArg(1 / ${ZERO});
    }
    match /argThroughTwoCallsUnreadAllow/{id} {
      allow create: if passesToIgnoresArg(1 / ${ZERO});
    }
    match /argThroughTwoCallsReadDeny/{id} {
      allow create: if passesToReadsArg(1 / ${ZERO});
    }
    match /argMissingFieldUnreadAllow/{id} {
      allow create: if ignoresArg(request.resource.data.missing);
    }
    match /letUnreadAllow/{id} {
      allow create: if letUnread();
    }
    match /letReadDeny/{id} {
      allow create: if letRead();
    }
    // Division and modulo by a zero read from data.
    match /divideByDataZeroDeny/{id} {
      allow create: if request.resource.data.one / ${ZERO} == 1;
    }
    match /moduloByDataZeroDeny/{id} {
      allow create: if request.resource.data.one % ${ZERO} == 1;
    }
    match /divideByDataZeroOrTrueAllow/{id} {
      allow create: if request.resource.data.one / ${ZERO} == 1 || true;
    }
    // Which of two errors is reported.
    match /firstErrorEq/{id} {
      allow create: if request.resource.data.missingA == request.resource.data.missingB;
    }
    match /firstErrorPlus/{id} {
      allow create: if request.resource.data.missingA + request.resource.data.missingB == 1;
    }
    match /firstErrorList/{id} {
      allow create: if [request.resource.data.missingA, request.resource.data.missingB] == [];
    }
    match /firstErrorMap/{id} {
      allow create: if {'a': request.resource.data.missingA, 'b': request.resource.data.missingB} == {};
    }
    match /firstErrorIn/{id} {
      allow create: if request.resource.data.missingA in [request.resource.data.missingB];
    }
    match /firstErrorMethodArgs/{id} {
      allow create: if request.resource.data.get(request.resource.data.missingA, request.resource.data.missingB) == 1;
    }
    match /firstErrorReceiver/{id} {
      allow create: if request.resource.data.missingA.get(request.resource.data.missingB, 1) == 1;
    }
    match /firstErrorFunctionArgs/{id} {
      allow create: if readsSecondArg(request.resource.data.missingA, request.resource.data.missingB);
    }
    // An operand past the limit after an error in the same expression.
    match /errThenOperandOverLimitDeny/{id} {
      allow create: if [request.resource.data.missing, overLimit0()] == [];
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
    ...([
      ['errThenTrueAllow', 'an error, then a true rule in the same block → ALLOW', 'ALLOW'],
      ['errThenFalseDeny', 'an error, then a false rule in the same block → DENY', 'DENY'],
      ['trueThenErrAllow', 'a true rule, then an error in the same block → ALLOW', 'ALLOW'],
      ['falseThenErrDeny', 'a false rule, then an error in the same block → DENY', 'DENY'],
      ['blocksErrThenTrueAllow', 'an error, then a true rule in a second matching block → ALLOW', 'ALLOW'],
      ['blocksErrThenFalseDeny', 'an error, then a false rule in a second matching block → DENY', 'DENY'],
      ['blocksTrueThenErrAllow', 'a true rule, then an error in a second matching block → ALLOW', 'ALLOW'],
      ['blocksFalseThenErrDeny', 'a false rule, then an error in a second matching block → DENY', 'DENY'],
      ['errThenOverLimitDeny', 'an error, then a true rule past the expression limit → DENY, reported as the error', 'DENY'],
      ['falseThenOverLimitDeny', 'a false rule, then a true rule past the expression limit → DENY at the limit', 'DENY'],
    ] as const).map(([collection, description, expectation]) => ({
      description,
      expectation,
      method: 'create' as const,
      path: `${collection}/d1`,
      auth: { uid: 'alice' },
      data: { present: 1 },
    })),
    ...([
      ['argUnreadAllow', 'an erroring argument the function never reads → ALLOW', 'ALLOW'],
      ['argReadDeny', 'an erroring argument the function reads → DENY', 'DENY'],
      ['argThroughTwoCallsUnreadAllow', 'an erroring argument passed through two calls and never read → ALLOW', 'ALLOW'],
      ['argThroughTwoCallsReadDeny', 'an erroring argument passed through two calls and read → DENY', 'DENY'],
      ['argMissingFieldUnreadAllow', 'a missing-field argument the function never reads → ALLOW', 'ALLOW'],
      ['letUnreadAllow', 'an erroring let the function never reads → ALLOW', 'ALLOW'],
      ['letReadDeny', 'an erroring let the function reads → DENY', 'DENY'],
      ['divideByDataZeroDeny', 'int division by a zero from data → DENY', 'DENY'],
      ['moduloByDataZeroDeny', 'int modulo by a zero from data → DENY', 'DENY'],
      ['divideByDataZeroOrTrueAllow', 'int division by a zero from data, || true → ALLOW', 'ALLOW'],
      ['firstErrorEq', 'two erroring operands of == → DENY, reported as the left one', 'DENY'],
      ['firstErrorPlus', 'two erroring operands of + → DENY, reported as the left one', 'DENY'],
      ['firstErrorList', 'two erroring list elements → DENY, reported as the first', 'DENY'],
      ['firstErrorMap', 'two erroring map values → DENY, reported as the first', 'DENY'],
      ['firstErrorIn', 'an erroring element and collection of in → DENY, reported as the collection', 'DENY'],
      ['firstErrorMethodArgs', 'two erroring method arguments → DENY, reported as the first', 'DENY'],
      ['firstErrorReceiver', 'an erroring receiver and argument → DENY, reported as the receiver', 'DENY'],
      ['firstErrorFunctionArgs', 'two erroring function arguments, the second read → DENY, reported as the second', 'DENY'],
      ['errThenOperandOverLimitDeny', 'an error, then an operand past the expression limit in the same expression → DENY at the limit', 'DENY'],
    ] as const).map(([collection, description, expectation]) => ({
      description,
      expectation,
      method: 'create' as const,
      path: `${collection}/d1`,
      auth: { uid: 'alice' },
      data: { present: 1, one: 1, zero: 0 },
    })),
  ],
  group: 'fix-class',
};
