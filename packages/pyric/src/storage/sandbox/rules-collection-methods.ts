import { FirestoreSet, SET_ALGEBRA_NAMES, SetMethodFailure, setMethod } from '../../rules/simulator/firestore-set.js';
import {
  ListMethodFailure,
  listConcat,
  listJoin,
  listMembership,
  listRemoveAll,
  type ListMembershipMethod,
} from '../../rules/simulator/list-methods.js';
import { MapMethodFailure, mapList, type MapListMethod } from '../../rules/simulator/map-keys.js';
import { MapDiff } from '../../rules/simulator/mapdiff.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  evalValueMethod,
  expectNoArguments,
  functionNotFound,
  type MethodCall,
  type ReceiverMethod,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { describeRulesType as describeType, isRulesMap } from '../../rules/simulator/rules-type.js';
import { isRuleError as isErr } from './rules-values.js';

const MAP_DIFF_KEY_SETS = ['addedKeys', 'affectedKeys', 'changedKeys', 'removedKeys', 'unchangedKeys'] as const;
type MapDiffKeySet = (typeof MAP_DIFF_KEY_SETS)[number];

/**
 * `.size()` on the sized types: string length, list element count, map
 * own-key count, Set member count, and the Bytes count the Bytes value
 * answers for itself.
 */
function evalSize(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (receiver instanceof FirestoreSet) return evalSetMethod(receiver, expr, ctx);
  expectNoArguments(expr);
  if (typeof receiver === 'string' || Array.isArray(receiver)) return receiver.length;
  if (isRulesMap(receiver)) return Object.keys(receiver).length;
  return evalValueMethod(receiver, expr);
}

/**
 * `Map.keys()` in code point order and `Map.values()` in written order
 * (`map-keys.ts`), own keys only, never JS prototypes.
 */
function evalMapList(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!isRulesMap(receiver)) throw functionNotFound(expr.method);
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const result = mapList(expr.method as MapListMethod, receiver, args);
  if (result instanceof MapMethodFailure) throw new RuleEvalError(result.message);
  return result;
}

/** A Set receiver's methods, shared with the Firestore simulator (`firestore-set.ts`). */
function evalSetMethod(receiver: FirestoreSet, expr: MethodCall, ctx: EvalCtx): unknown {
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const result = setMethod(receiver, expr.method, args);
  if (result instanceof SetMethodFailure) throw new RuleEvalError(result.message);
  return result;
}

/** The List methods `list-methods.ts` implements for both evaluators. */
const LIST_METHODS = {
  concat: (receiver: unknown[], args: unknown[]) => listConcat(receiver, args),
  join: (receiver: unknown[], args: unknown[]) => listJoin(receiver, args),
  removeAll: (receiver: unknown[], args: unknown[]) => listRemoveAll(receiver, args),
} as const;

/**
 * `List.concat()`, `List.join()` and `List.removeAll()`. Another
 * receiver type, a Set included, is production's function-not-found error.
 */
function evalListMethod(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!Array.isArray(receiver)) throw functionNotFound(expr.method);
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const result = LIST_METHODS[expr.method as keyof typeof LIST_METHODS](receiver, args);
  if (result instanceof ListMethodFailure) throw new RuleEvalError(result.message);
  return result;
}

/** `Map.get(key, default)` for the production-probed string-key form. */
function evalMapGet(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!isRulesMap(receiver)) throw functionNotFound(expr.method);
  if (expr.args.length !== 2) {
    throw new RuleEvalError(`get() expects a key and default value`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const [key, fallback] = args;
  if (typeof key !== 'string') {
    throw new RuleEvalError(`get() key must be a string`);
  }
  return Object.prototype.hasOwnProperty.call(receiver, key) ? receiver[key] : fallback;
}

/**
 * `hasAll`, `hasAny`, and `hasOnly`. A List receiver takes one List
 * argument (`list-methods.ts`) and a Set receiver one List or Set
 * (`firestore-set.ts`).
 */
function evalMembership(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (receiver instanceof FirestoreSet) return evalSetMethod(receiver, expr, ctx);
  if (!Array.isArray(receiver)) throw functionNotFound(expr.method);
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const result = listMembership(expr.method as ListMembershipMethod, receiver, args);
  if (result instanceof ListMethodFailure) throw new RuleEvalError(result.message);
  return result;
}

/** `List.toSet()`: the list's distinct members as a Set. */
function evalToSet(receiver: unknown, expr: MethodCall): unknown {
  if (!Array.isArray(receiver)) throw functionNotFound(expr.method);
  if (expr.args.length !== 0) {
    throw new RuleEvalError(`Incorrect number of arguments. Received: ${expr.args.length}. Expected: list.toSet().`);
  }
  return new FirestoreSet(receiver);
}

/**
 * `Set.difference`, `Set.union`, and `Set.intersection` (`firestore-set.ts`).
 * Another receiver type is production's function-not-found error.
 */
function evalSetAlgebra(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!(receiver instanceof FirestoreSet)) throw functionNotFound(expr.method);
  return evalSetMethod(receiver, expr, ctx);
}

/**
 * `Map.diff(other)`: a MapDiff from `other` (the before state) to the
 * receiver (the after state), as in
 * `request.resource.metadata.diff(resource.metadata)`.
 */
function evalMapDiff(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!isRulesMap(receiver)) throw functionNotFound(expr.method);
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`diff() expects one map argument`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const [before] = args;
  if (!isRulesMap(before)) {
    throw new RuleEvalError(`diff() argument must be a map, got ${describeType(before)}`);
  }
  return new MapDiff(before, receiver);
}

/** The MapDiff key sets `addedKeys()` through `unchangedKeys()`, each a Set. */
function evalMapDiffKeySet(receiver: unknown, expr: MethodCall): unknown {
  expectNoArguments(expr);
  if (!(receiver instanceof MapDiff)) throw functionNotFound(expr.method);
  return receiver[expr.method as MapDiffKeySet]();
}

function methodsNamed(names: readonly string[], method: ReceiverMethod): ReceiverMethods {
  return Object.fromEntries(names.map((name) => [name, method]));
}

export const collectionMethods: ReceiverMethods = {
  concat: evalListMethod,
  diff: evalMapDiff,
  get: evalMapGet,
  hasAll: evalMembership,
  hasAny: evalMembership,
  hasOnly: evalMembership,
  join: evalListMethod,
  keys: evalMapList,
  removeAll: evalListMethod,
  size: evalSize,
  toSet: evalToSet,
  values: evalMapList,
  ...methodsNamed([...SET_ALGEBRA_NAMES], evalSetAlgebra),
  ...methodsNamed(MAP_DIFF_KEY_SETS, evalMapDiffKeySet),
};
