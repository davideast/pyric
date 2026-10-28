import { evalOperand, type EvalCtx } from './rules-evaluator.js';
import { collectionMethods } from './rules-collection-methods.js';
import { evalFirestoreBuiltin } from './rules-firestore-lookup.js';
import { bytesMethods, evalHashingNamespace } from './rules-hashing-methods.js';
import { evalLatLngNamespace, latlngMethods } from './rules-latlng.js';
import { evalMathNamespace } from './rules-math-methods.js';
import { evalArguments, functionNotFound, type MethodCall, type NamespaceMethod, type ReceiverMethod, type ReceiverMethods } from './rules-method-calls.js';
import { pathMethods } from './rules-path.js';
import { stringMethods } from './rules-string-methods.js';
import { evalDurationNamespace, evalTimestampNamespace, timeMethods } from './rules-time-methods.js';
import { isRuleError as isErr } from './rules-values.js';

/** The builtin namespaces, keyed by the bare identifier a call names. */
const NAMESPACES: ReadonlyMap<string, NamespaceMethod> = new Map([
  ['duration', evalDurationNamespace],
  ['firestore', evalFirestoreBuiltin],
  ['hashing', evalHashingNamespace],
  ['latlng', evalLatLngNamespace],
  ['math', evalMathNamespace],
  ['timestamp', evalTimestampNamespace],
]);

/** Every receiver method the evaluator models, one record per concern. */
const RECEIVER_METHODS: ReadonlyMap<string, ReceiverMethod> = mergeReceiverMethods([
  bytesMethods,
  collectionMethods,
  latlngMethods,
  pathMethods,
  stringMethods,
  timeMethods,
]);

/**
 * Evaluate a `<target>.<method>(args)` call.
 *
 * A bare `timestamp`, `duration`, `hashing`, `latlng`, `math`, or `firestore` identifier that
 * no local or path parameter shadows is a builtin namespace. Otherwise the
 * target is a receiver: it evaluates first, an error receiver propagates,
 * and the method's evaluator checks the receiver type. A method the
 * receiver does not define, whether another type models it or no type does,
 * is production's function-not-found error, which `&&`/`||` may absorb
 * (rules-storage-h1-unknown-method-absorption captures `'a'.foo() || true`
 * allowing), as the Firestore simulator's is.
 */
export function evalMethodCall(expr: MethodCall, ctx: EvalCtx): unknown {
  const namespace = builtinNamespace(expr, ctx);
  // A namespace call charges the unit it costs beyond its arguments itself
  // (`evalNamespaceArguments`).
  if (namespace !== undefined) return namespace(expr, ctx);

  const method = RECEIVER_METHODS.get(expr.method) ?? unknownMethod;
  const receiver = evalOperand(expr.target, ctx);
  // `resource.name.matches(…)` on an object whose `name` is absent: the
  // receiver is already production's absent-property error. Propagate it
  // (→ deny) rather than recasting it as a method-specific failure, after
  // evaluating the arguments, which production evaluates and counts too.
  if (isErr(receiver)) {
    evalArguments(expr, ctx);
    return receiver;
  }
  return method(receiver, expr, ctx);
}

/** A method name no receiver type defines: production's function-not-found error. */
function unknownMethod(_receiver: unknown, expr: MethodCall): never {
  throw functionNotFound(expr.method);
}

/** The namespace a call names, when its target is an unshadowed builtin identifier. */
function builtinNamespace(expr: MethodCall, ctx: EvalCtx): NamespaceMethod | undefined {
  if (expr.target.kind !== 'ident') return undefined;
  const name = expr.target.name;
  if (Object.hasOwn(ctx.locals, name) || Object.hasOwn(ctx.params, name)) return undefined;
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
