import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import { RuleUnsupportedError } from './rules-evaluation-error.js';
import { collectionMethods } from './rules-collection-methods.js';
import { evalFirestoreBuiltin } from './rules-firestore-lookup.js';
import { bytesMethods, evalHashingNamespace } from './rules-hashing-methods.js';
import type { MethodCall, NamespaceMethod, ReceiverMethod, ReceiverMethods } from './rules-method-calls.js';
import { stringMethods } from './rules-string-methods.js';
import { evalDurationNamespace, evalTimestampNamespace, timeMethods } from './rules-time-methods.js';
import { isRuleError as isErr } from './rules-values.js';

/** The builtin namespaces, keyed by the bare identifier a call names. */
const NAMESPACES: ReadonlyMap<string, NamespaceMethod> = new Map([
  ['duration', evalDurationNamespace],
  ['firestore', evalFirestoreBuiltin],
  ['hashing', evalHashingNamespace],
  ['timestamp', evalTimestampNamespace],
]);

/** Every receiver method the evaluator models, one record per concern. */
const RECEIVER_METHODS: ReadonlyMap<string, ReceiverMethod> = mergeReceiverMethods([
  bytesMethods,
  collectionMethods,
  stringMethods,
  timeMethods,
]);

/**
 * Evaluate a `<target>.<method>(args)` call.
 *
 * A bare `timestamp`, `duration`, `hashing`, or `firestore` identifier that
 * no local or path parameter shadows is a builtin namespace. Otherwise the
 * target is a receiver: it evaluates first, an error receiver propagates,
 * and the method's evaluator checks the receiver type. A modeled method on
 * a receiver that lacks it is production's function-not-found error, which
 * `&&`/`||` may absorb. An unmodeled method name is either unmodeled here or
 * rejected by production's compiler; its verdict is unknowable locally, so
 * it is unabsorbable and fails closed even under a determining operand.
 */
export function evalMethodCall(expr: MethodCall, ctx: EvalCtx): unknown {
  const namespace = builtinNamespace(expr, ctx);
  if (namespace !== undefined) return namespace(expr, ctx);

  const method = RECEIVER_METHODS.get(expr.method);
  if (method === undefined) {
    throw new RuleUnsupportedError(`unsupported method .${expr.method}()`);
  }
  const receiver = evalExpr(expr.target, ctx);
  // `resource.name.matches(…)` on an object whose `name` is absent: the
  // receiver is already production's absent-property error. Propagate it
  // (→ deny) rather than recasting it as a method-specific failure.
  if (isErr(receiver)) return receiver;
  return method(receiver, expr, ctx);
}

/** The namespace a call names, when its target is an unshadowed builtin identifier. */
function builtinNamespace(expr: MethodCall, ctx: EvalCtx): NamespaceMethod | undefined {
  if (expr.target.kind !== 'ident') return undefined;
  const name = expr.target.name;
  if (name in ctx.locals || name in ctx.params) return undefined;
  return NAMESPACES.get(name);
}

/** One table from the concern records; a name two records claim is a wiring error. */
function mergeReceiverMethods(records: readonly ReceiverMethods[]): ReadonlyMap<string, ReceiverMethod> {
  const merged = new Map<string, ReceiverMethod>();
  for (const record of records) {
    for (const [name, method] of Object.entries(record)) {
      if (merged.has(name)) {
        throw new Error(`storage rules method .${name}() has two evaluators`);
      }
      merged.set(name, method);
    }
  }
  return merged;
}
