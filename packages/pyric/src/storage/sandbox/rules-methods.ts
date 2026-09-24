import type { Expr } from './rules.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleUnsupportedError } from './rules-evaluation-error.js';
import { evalHasAll, evalMapGet, evalMapKeys, evalSize } from './rules-collection-methods.js';
import { evalFirestoreBuiltin } from './rules-firestore-lookup.js';
import { evalMatches, evalSplit } from './rules-string-methods.js';
import { evalDurationBuiltin, evalTimestampBuiltin } from './rules-time-methods.js';

// ═══════════════════════════════════════════════════════════════
// Builtin method / namespace calls
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate a `<target>.<method>(args)` call. Two builtin families are
 * supported; everything else denies (throws `RuleEvalError`), so unknown
 * builtins — including deliberately-out-of-scope `firestore.get`/`exists` —
 * deny with a reason rather than ever a false allow.
 *
 *   - `string.matches(re)` — RE2-style whole-string regex match.
 *   - `timestamp.date(y, m, d)` / `timestamp.value(epochMillis)` —
 *     timestamp constructors, returned as epoch millis to compare against
 *     `request.time`.
 */
export function evalMethodCall(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
  // Timestamp namespace: `timestamp.date(...)` / `timestamp.value(...)`.
  // Detected structurally on the bare `timestamp` identifier (not a bound
  // local/param/global) so a user value named `timestamp` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'timestamp' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalTimestampBuiltin(expr, ctx);
  }

  // Duration namespace: `duration.value(n, unit)`. Detected on the bare
  // `duration` identifier so a user value named `duration` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'duration' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalDurationBuiltin(expr, ctx);
  }

  // Firestore namespace: `firestore.get(path)` / `firestore.exists(path)`.
  // Detected on the bare `firestore` identifier (not a bound local/param) so
  // a user value named `firestore` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'firestore' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalFirestoreBuiltin(expr, ctx);
  }

  if (expr.method === 'matches') {
    return evalMatches(expr, ctx);
  }

  if (expr.method === 'split') {
    return evalSplit(expr, ctx);
  }

  if (expr.method === 'size') {
    return evalSize(expr, ctx);
  }

  if (expr.method === 'keys') {
    return evalMapKeys(expr, ctx);
  }

  if (expr.method === 'hasAll') {
    return evalHasAll(expr, ctx);
  }

  if (expr.method === 'get') {
    return evalMapGet(expr, ctx);
  }

  // An unknown method name is either unmodeled here or rejected by
  // production's compiler. Its verdict is unknowable locally, so it is
  // unabsorbable (fails closed even under a determining &&/|| operand).
  throw new RuleUnsupportedError(`unsupported method .${expr.method}()`);
}
