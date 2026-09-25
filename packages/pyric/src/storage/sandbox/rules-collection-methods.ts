import { FirestoreSet } from '../../rules/simulator/firestore-set.js';
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
import {
  describeRulesType as describeType,
  isRuleError as isErr,
  isRulesMap,
  rulesEquals,
} from './rules-values.js';

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

/** `Map.keys()` returns the map's own keys and never exposes JS prototypes. */
function evalMapKeys(receiver: unknown, expr: MethodCall): unknown {
  expectNoArguments(expr);
  if (!isRulesMap(receiver)) throw functionNotFound(expr.method);
  return Object.keys(receiver);
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
 * `hasAll`, `hasAny`, and `hasOnly` on a List or Set receiver, with a List
 * or Set argument, under Rules value equality.
 */
function evalMembership(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  const members = membersOf(receiver);
  if (members === undefined) throw functionNotFound(expr.method);
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`${expr.method}() expects one list or set argument`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const candidates = membersOf(args[0]);
  if (candidates === undefined) {
    throw new RuleEvalError(`${expr.method}() argument must be a list or set`);
  }
  const contains = (values: unknown[], value: unknown) => values.some((item) => rulesEquals(item, value));
  if (expr.method === 'hasAll') return candidates.every((candidate) => contains(members, candidate));
  if (expr.method === 'hasAny') return candidates.some((candidate) => contains(members, candidate));
  return members.every((member) => contains(candidates, member));
}

/** The members of a List or Set, or undefined for any other value. */
function membersOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value instanceof FirestoreSet) return value.toArray();
  return undefined;
}

/** `List.toSet()`: the list's distinct members as a Set. */
function evalToSet(receiver: unknown, expr: MethodCall): unknown {
  expectNoArguments(expr);
  if (!Array.isArray(receiver)) throw functionNotFound(expr.method);
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
  diff: evalMapDiff,
  get: evalMapGet,
  hasAll: evalMembership,
  hasAny: evalMembership,
  hasOnly: evalMembership,
  keys: evalMapKeys,
  size: evalSize,
  toSet: evalToSet,
  ...methodsNamed(SET_ALGEBRA, evalSetAlgebra),
  ...methodsNamed(MAP_DIFF_KEY_SETS, evalMapDiffKeySet),
};
