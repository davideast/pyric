/** Fatal evaluator misuse caught at the allow boundary and converted to a deny. */
export class RuleEvalError extends Error {}

/**
 * A construct whose production verdict is unknowable locally: either
 * production rejects the ruleset at deploy time (undefined function, wrong
 * arity, unresolved import, unknown namespace method) or the simulator
 * cannot model the construct at all. Its effect is EVALUATION-WIDE in
 * production, where a determining `&&`/`||` operand cannot rescue it, so it is
 * never absorbed and always fails closed.
 */
export class RuleUnsupportedError extends RuleEvalError {}

/**
 * A resource-limit exhaustion (the two-document Firestore lookup cap, the
 * max call depth). Production fails the WHOLE evaluation closed on these:
 * they are not CEL error values, so commutative `&&`/`||` absorption must
 * not turn one into an allow (same posture as the Firestore simulator's
 * LookupBudgetError precedent).
 */
export class RuleResourceLimitError extends RuleEvalError {}

/**
 * True for the errors that CEL `&&`/`||` absorption may treat as an error
 * VALUE at an operand boundary: genuine rule-evaluation failures, excluding
 * the unsupported/compile-reject and resource-limit classes above.
 */
export function isAbsorbableEvalError(err: unknown): err is RuleEvalError {
  return (
    err instanceof RuleEvalError
    && !(err instanceof RuleUnsupportedError)
    && !(err instanceof RuleResourceLimitError)
  );
}
