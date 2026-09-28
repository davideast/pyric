import { FirestoreSet } from '../../rules/simulator/firestore-set.js';
import {
  ListMethodFailure,
  listConcat,
  listHas,
  listJoin,
  listRemoveAll,
  type ListMembershipMethod,
} from '../../rules/simulator/list-methods.js';
import { mapKeys } from '../../rules/simulator/map-keys.js';
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

const SET_ALGEBRA = ['difference', 'intersection', 'union'] as const;
type SetAlgebraMethod = (typeof SET_ALGEBRA)[number];

const MAP_DIFF_KEY_SETS = ['addedKeys', 'affectedKeys', 'changedKeys', 'removedKeys', 'unchangedKeys'] as const;
type MapDiffKeySet = (typeof MAP_DIFF_KEY_SETS)[number];

/**
 * `.size()` on the sized types: string length, list element count, map
 * own-key count, Set member count, and the Bytes count the Bytes value
 * answers for itself.
 */
function evalSize(receiver: unknown, expr: MethodCall): unknown {
  expectNoArguments(expr);
  if (typeof receiver === 'string' || Array.isArray(receiver)) return receiver.length;
  if (isRulesMap(receiver)) return Object.keys(receiver).length;
  if (receiver instanceof FirestoreSet) return receiver.size();
  return evalValueMethod(receiver, expr);
}

/** `Map.keys()` returns the map's own keys in code point order and never exposes JS prototypes. */
function evalMapKeys(receiver: unknown, expr: MethodCall): unknown {
  expectNoArguments(expr);
  if (!isRulesMap(receiver)) throw functionNotFound(expr.method);
  return mapKeys(receiver);
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
 * `hasAll`, `hasAny`, and `hasOnly`. A List receiver takes a List argument
 * and compares elements as List membership does; a Set receiver takes a List
 * or Set and compares elements as the Set does. Any other argument, a Set to
 * a List receiver included, is an unsupported operation
 * (rules-storage-upload-primitives-boundaries).
 */
function evalMembership(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!Array.isArray(receiver) && !(receiver instanceof FirestoreSet)) throw functionNotFound(expr.method);
  const receiverType = Array.isArray(receiver) ? 'list' : 'set';
  const overloads = receiverType === 'list'
    ? `list.${expr.method}(list)`
    : `set.${expr.method}(set), set.${expr.method}(list)`;
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`Incorrect number of arguments. Received: ${expr.args.length}. Expected: ${overloads}.`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const [argument] = args;
  const accepted = Array.isArray(argument) || (receiverType === 'set' && argument instanceof FirestoreSet);
  if (!accepted) {
    throw new RuleEvalError(
      `Unsupported operation error. Received: ${receiverType}.${expr.method}(${describeType(argument)}). Expected: ${overloads}.`,
    );
  }
  const method = expr.method as ListMembershipMethod;
  if (Array.isArray(receiver)) return listHas(method, receiver, argument as unknown[]);
  return receiver[method](argument as unknown[] | FirestoreSet);
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
 * `Set.difference`, `Set.union`, and `Set.intersection`. They take a Set
 * argument; production rejects a List argument with "Unsupported operation
 * error" and a List receiver with "Function not found error", both captured
 * by rules-storage-stdlib-sets-and-mapdiff.
 */
function evalSetAlgebra(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!(receiver instanceof FirestoreSet)) throw functionNotFound(expr.method);
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`${expr.method}() expects one set argument`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const [other] = args;
  if (!(other instanceof FirestoreSet)) {
    throw new RuleEvalError(
      `Unsupported operation error. Received: set.${expr.method}(${describeType(other)}). Expected: set.${expr.method}(set).`,
    );
  }
  return receiver[expr.method as SetAlgebraMethod](other);
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
  keys: evalMapKeys,
  removeAll: evalListMethod,
  size: evalSize,
  toSet: evalToSet,
  ...methodsNamed(SET_ALGEBRA, evalSetAlgebra),
  ...methodsNamed(MAP_DIFF_KEY_SETS, evalMapDiffKeySet),
};
