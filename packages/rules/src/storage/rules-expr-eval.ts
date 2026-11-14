import { ConversionFailure, applyConversion, conversionFor } from '../simulator/conversions.js';
import { ExpressionBudget } from '../simulator/expression-budget.js';
import { FirestoreSet } from '../simulator/firestore-set.js';
import { IndexAccessFailure, indexValue, readMember } from '../simulator/index-access.js';
import { mapLiteral } from '../simulator/map-keys.js';
import { MembershipFailure, membership } from '../simulator/membership.js';
import { IntFailure, negateInt, rulesFloatValue, rulesInt } from '../simulator/rules-int.js';
import { describeRulesType as describeType, isRulesMap } from '../simulator/rules-type.js';
import { sliceBoundsError } from '../simulator/slice-bounds.js';
import { rulesValuesEqual } from '../simulator/value-equality.js';
import { Duration } from '../simulator/wrappers/duration.js';
import { RulesFloat } from '../simulator/wrappers/float.js';
import {
  type EvaluationInput,
  type Expr,
  type FirestoreLookup,
  type FunctionMap,
} from './rules.js';
import { buildRequestObject, buildResourceObject } from './rules-bindings.js';
import type { StorageEvaluationObservation } from './rules-evaluator.js';
import {
  RuleEvalError,
  RuleResourceLimitError,
  RuleUnsupportedError,
  isAbsorbableEvalError,
} from './rules-evaluation-error.js';
import { evalMethodCall } from './rules-methods.js';
import {
  evalArithmetic,
  evalOrdering,
  evalValueOperator,
  isValueTypeOperand,
  typeMatches,
} from './rules-operators.js';
import type { PathParamValue } from './rules-path-match.js';
import { StoragePath, interpolationSegments } from './rules-path.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

export type TrackedRoot = 'request' | 'auth' | 'token' | 'firebase' | 'identities';

/** `obj.name`: a map's own key, a path's bound name, or production's error (`index-access.ts`). */
function readProperty(obj: unknown, name: string): unknown {
  const value = readMember(obj, name);
  if (value instanceof IndexAccessFailure) return new RuleError(value.message);
  return value;
}

/** Everything an expression needs to evaluate. */
export interface EvalCtx {
  input: EvaluationInput;
  /** The evaluation instant in epoch milliseconds; `request.time` is its Timestamp. */
  now: number;
  /** Path wildcards visible in the current lexical scope. */
  params: Record<string, PathParamValue>;
  /** Full path wildcards captured by the matched `allow` rule's `match` chain. */
  matchParams?: Record<string, PathParamValue>;
  /** Lexical scope kind (`'global'` above `service`, `'service'` inside `service`, `'match'` inside `match`). */
  scopeKind?: 'global' | 'service' | 'match';
  /** Function parameter and `let` bindings for the current body. */
  locals: Record<string, unknown>;
  /** Functions callable from the current scope. */
  funcs: FunctionMap;
  /** Optional Firestore read capability for `firestore.get()/exists()`. */
  firestoreLookup?: FirestoreLookup;
  /** Distinct Firestore document paths charged during this evaluation. */
  firestoreAccesses: Set<string>;
  /** Per-request expression budget; absent in direct evaluator use. */
  expressionBudget?: ExpressionBudget;
  /** Optional host observation sink for live traffic gap & rule diagnostics. */
  observation?: StorageEvaluationObservation;
  /** Tracks live wrapper objects back to request/auth/token for property observation. */
  trackedRoots?: WeakMap<object, TrackedRoot>;
}

export function evalExpr(expr: Expr, ctx: EvalCtx): unknown {
  const budget = ctx.expressionBudget;
  if (!budget) return evalNode(expr, ctx);
  if (expr.kind === 'call') {
    budget.call(expr);
    return evalNode(expr, ctx);
  }
  let value: unknown;
  try {
    value = evalNode(expr, ctx);
  } catch (e) {
    if (!(e instanceof RuleResourceLimitError)) budget.node(expr);
    throw e;
  }
  budget.node(expr);
  return value;
}

export function trackObject(ctx: EvalCtx, value: unknown, kind: TrackedRoot): void {
  if (ctx.trackedRoots && value !== null && typeof value === 'object') {
    ctx.trackedRoots.set(value, kind);
  }
}

function notePropertyRead(ctx: EvalCtx, target: unknown, name: string, result: unknown): void {
  const obs = ctx.observation;
  const tracked = ctx.trackedRoots;
  if (!obs || !tracked || target === null || typeof target !== 'object') return;
  const kind = tracked.get(target);
  if (kind === 'request') {
    if (name === 'resource') obs.readRequestResource = true;
    else if (name === 'auth') trackObject(ctx, result, 'auth');
  } else if (kind === 'auth') {
    if (name === 'token') {
      obs.readAuthToken = true;
      trackObject(ctx, result, 'token');
    }
  } else if (kind === 'token') {
    if (name === 'email') obs.readAuthTokenEmail = true;
    else if (name === 'firebase') trackObject(ctx, result, 'firebase');
  } else if (kind === 'firebase') {
    if (name === 'identities') trackObject(ctx, result, 'identities');
  } else if (kind === 'identities') {
    if (name === 'email') obs.readAuthTokenEmail = true;
  }
}

export function noteMapGetRead(ctx: EvalCtx, receiver: unknown, key: string | readonly string[]): void {
  const obs = ctx.observation;
  const tracked = ctx.trackedRoots;
  if (!obs || !tracked || receiver === null || typeof receiver !== 'object') return;
  if (typeof key === 'string') {
    let next: unknown;
    if (isRulesMap(receiver) && Object.hasOwn(receiver, key)) {
      next = receiver[key];
    }
    notePropertyRead(ctx, receiver, key, next);
    return;
  }
  const kind = tracked.get(receiver);
  const readsIdentitiesEmail =
    (kind === 'token' && key[0] === 'firebase' && key[1] === 'identities' && key[2] === 'email') ||
    (kind === 'firebase' && key[0] === 'identities' && key[1] === 'email') ||
    (kind === 'identities' && key[0] === 'email');
  if (readsIdentitiesEmail) {
    obs.readAuthTokenEmail = true;
  }
  let current: unknown = receiver;
  for (const part of key) {
    if (!isRulesMap(current)) break;
    let next: unknown;
    if (Object.hasOwn(current, part)) {
      next = current[part];
    }
    notePropertyRead(ctx, current, part, next);
    if (next === undefined) break;
    current = next;
  }
}

export function noteMapEnumerationRead(ctx: EvalCtx, receiver: unknown): void {
  const obs = ctx.observation;
  const tracked = ctx.trackedRoots;
  if (!obs || !tracked || receiver === null || typeof receiver !== 'object') return;
  const kind = tracked.get(receiver);
  if (kind === 'request') {
    obs.readRequestResource = true;
    obs.readAuthToken = true;
    obs.readAuthTokenEmail = true;
  } else if (kind === 'auth') {
    obs.readAuthToken = true;
    obs.readAuthTokenEmail = true;
  } else if (kind === 'token' || kind === 'firebase' || kind === 'identities') {
    obs.readAuthToken = true;
    obs.readAuthTokenEmail = true;
  }
}

export function noteDeepMapEnumerationReads(
  ctx: EvalCtx,
  value: unknown,
  visited?: Set<object>,
): void {
  if (!ctx.observation || !ctx.trackedRoots || value === null || typeof value !== 'object') {
    return;
  }
  const seen = visited ?? new Set<object>();
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      noteDeepMapEnumerationReads(ctx, item, seen);
    }
    return;
  }
  if (value instanceof FirestoreSet) {
    for (const item of value.toArray()) {
      noteDeepMapEnumerationReads(ctx, item, seen);
    }
    return;
  }
  if (isRulesMap(value)) {
    noteMapEnumerationRead(ctx, value);
    for (const child of Object.values(value)) {
      noteDeepMapEnumerationReads(ctx, child, seen);
    }
  }
}

function evalNode(expr: Expr, ctx: EvalCtx): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ident': {
      if (Object.hasOwn(ctx.locals, expr.name)) return ctx.locals[expr.name];
      if (Object.hasOwn(ctx.params, expr.name)) return ctx.params[expr.name];
      if (ctx.scopeKind !== 'global') {
        if (expr.name === 'request') {
          const req = buildRequestObject(ctx.input, ctx.now);
          trackObject(ctx, req, 'request');
          return req;
        }
        if (expr.name === 'resource') {
          if (ctx.observation) ctx.observation.readResource = true;
          if (ctx.input.resource === null) {
            return new RuleError('Null value error.');
          }
          return buildResourceObject(ctx.input.resource);
        }
      }
      return new RuleError(`Identifier ${expr.name} is undefined.`);
    }
    case 'member': {
      const t = evalExpr(expr.target, ctx);
      if (isErr(t)) return t;
      if (t === null || t === undefined) return new RuleError('Null value error.');
      const prop = readProperty(t, expr.name);
      notePropertyRead(ctx, t, expr.name, prop);
      return prop;
    }
    case 'index': {
      const operands = evalOperands([expr.index, expr.target], ctx);
      if (isErr(operands)) return operands;
      const [idx, t] = operands;
      if (t === null || t === undefined) return new RuleError('Null value error.');
      const element = indexValue(t, idx);
      let out: unknown = element;
      if (element instanceof IndexAccessFailure) {
        out = new RuleError(element.message);
      }
      if (typeof idx === 'string') notePropertyRead(ctx, t, idx, out);
      return out;
    }
    case 'call':
      return evalCall(expr, ctx);
    case 'methodcall':
      return evalMethodCall(expr, ctx);
    case 'path': {
      const parts: string[] = [];
      let error: RuleError | undefined;
      for (const seg of expr.segments) {
        if (seg.kind === 'literal') {
          ctx.expressionBudget?.pathSegment(expr);
          parts.push(seg.value);
          continue;
        }
        const v = evalOperand(seg.expr, ctx);
        if (isErr(v)) {
          error ??= v;
          continue;
        }
        const segments = interpolationSegments(v);
        if (segments === undefined) {
          error ??= new RuleError(`Path interpolation resolved to ${describeType(v)} (expected a string or a path)`);
          continue;
        }
        parts.push(...segments);
      }
      if (error !== undefined) return error;
      return StoragePath.fromSegments(parts);
    }
    case 'unary': {
      const a = evalExpr(expr.arg, ctx);
      if (expr.op === '!') {
        if (isErr(a)) throw new RuleEvalError(a.message);
        if (typeof a !== 'boolean') {
          throw new RuleEvalError(`Unary '!' expects a boolean, got ${describeType(a)}.`);
        }
        return !a;
      }
      if (isErr(a)) return a;
      if (expr.op === '-') {
        const float = rulesFloatValue(a);
        if (float !== undefined) return new RulesFloat(-float);
        if (a instanceof Duration) return a.negated();
        const int = rulesInt(a);
        if (int === undefined) return new RuleError(`Unary '-' applied to ${describeType(a)}.`);
        const negated = negateInt(int);
        if (negated instanceof IntFailure) return new RuleError(negated.message);
        return negated;
      }
      return undefined;
    }
    case 'ternary': {
      ctx.expressionBudget?.ternary(expr);
      const c = evalExpr(expr.cond, ctx);
      if (isErr(c)) return c;
      if (typeof c !== 'boolean') {
        return new RuleError(`Ternary condition expected bool, got ${describeType(c)}.`);
      }
      if (c) return evalExpr(expr.then, ctx);
      ctx.expressionBudget?.ternaryElse(expr);
      return evalExpr(expr.else, ctx);
    }
    case 'in': {
      const operands = evalOperands([expr.collection, expr.element], ctx);
      if (isErr(operands)) return operands;
      const [coll, el] = operands;
      if (typeof el === 'string') notePropertyRead(ctx, coll, el, undefined);
      noteDeepMapEnumerationReads(ctx, el);
      if (Array.isArray(coll) || coll instanceof FirestoreSet) {
        noteDeepMapEnumerationReads(ctx, coll);
      }
      const result = membership(el, coll);
      if (result instanceof MembershipFailure) return new RuleError(result.message);
      return result;
    }
    case 'is': {
      const v = evalExpr(expr.value, ctx);
      if (isErr(v)) return v;
      return typeMatches(v, expr.typeName);
    }
    case 'list':
      return evalOperands(expr.elements, ctx);
    case 'map': {
      const values = evalOperands(expr.entries.flatMap((entry) => [entry.key, entry.value]), ctx);
      if (isErr(values)) return values;
      const entries: [string, unknown][] = [];
      for (let i = 0; i < values.length; i += 2) {
        const k = values[i];
        if (typeof k !== 'string') {
          return new RuleError(`Map literal key is ${describeType(k)} (expected a string).`);
        }
        entries.push([k, values[i + 1]]);
      }
      return mapLiteral(entries);
    }
    case 'slice': {
      const operands = evalOperands([expr.target, expr.start, expr.end], ctx);
      if (isErr(operands)) return operands;
      const [t, startValue, endValue] = operands;
      const start = rulesInt(startValue);
      const end = rulesInt(endValue);
      if (start === undefined || end === undefined) {
        return new RuleError('Slice bounds must be integers.');
      }
      if (Array.isArray(t) || typeof t === 'string') {
        const boundsError = sliceBoundsError(start, end, t.length);
        if (boundsError) return new RuleError(boundsError);
        return t.slice(Number(start), Number(end));
      }
      return new RuleError(`Slice applied to ${describeType(t)} (expected a list or string).`);
    }
    case 'binary': {
      if (expr.op === '&&') return evalAbsorbingOperator(expr, false, ctx);
      if (expr.op === '||') return evalAbsorbingOperator(expr, true, ctx);
      const operands = evalOperands([expr.left, expr.right], ctx);
      if (isErr(operands)) return operands;
      const [l, r] = operands;
      if (expr.op !== '==' && expr.op !== '!=' && (isValueTypeOperand(l) || isValueTypeOperand(r))) {
        return evalValueOperator(expr.op, l, r);
      }
      switch (expr.op) {
        case '==':
        case '!=': {
          if (l !== null && r !== null) {
            noteDeepMapEnumerationReads(ctx, l);
            noteDeepMapEnumerationReads(ctx, r);
          }
          const equal = rulesValuesEqual(l, r);
          if (expr.op === '==') return equal;
          return !equal;
        }
        case '<':
        case '>':
        case '<=':
        case '>=':
          return evalOrdering(expr.op, l, r);
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
          return evalArithmetic(expr.op, l, r);
      }
    }
  }
}

function evalAbsorbingOperator(
  operator: Extract<Expr, { kind: 'binary' }>,
  determining: boolean,
  ctx: EvalCtx,
): boolean | RuleError {
  const { left, right } = operator;
  const l = evalLogicalOperand(left, ctx);
  if (l === determining) return determining;
  ctx.expressionBudget?.logicalRight(operator);
  const r = evalLogicalOperand(right, ctx);
  if (r === determining) return determining;
  if (isErr(l)) return l;
  return r;
}

function evalLogicalOperand(expr: Expr, ctx: EvalCtx): boolean | RuleError {
  const v = evalOperand(expr, ctx);
  if (isErr(v)) return v;
  if (typeof v !== 'boolean') {
    return new RuleError(`Expected a boolean '&&'/'||' operand, got ${describeType(v)}.`);
  }
  return v;
}

export function evalOperand(expr: Expr, ctx: EvalCtx): unknown {
  try {
    return evalExpr(expr, ctx);
  } catch (err) {
    if (isAbsorbableEvalError(err)) return new RuleError(err.message);
    throw err;
  }
}

export function evalOperands(exprs: readonly Expr[], ctx: EvalCtx): unknown[] | RuleError {
  const values: unknown[] = [];
  let error: RuleError | undefined;
  for (const expr of exprs) {
    const value = evalOperand(expr, ctx);
    if (isErr(value)) error ??= value;
    values.push(value);
  }
  return error ?? values;
}

function evalCall(expr: Extract<Expr, { kind: 'call' }>, ctx: EvalCtx): unknown {
  const fn = ctx.funcs.get(expr.name);
  if (!fn) return evalGlobalCall(expr, ctx);
  if (fn.unresolvedImport !== undefined) {
    throw new RuleUnsupportedError(
      `function ${expr.name}() is imported from '${fn.unresolvedImport}', but import module resolution is not implemented`,
    );
  }
  const argVals = expr.args.map((a) => evalOperand(a, ctx));
  if (fn.params.length !== expr.args.length) {
    return new RuleError(
      `Incorrect number of arguments. Received: ${expr.args.length}. Expected: ${expr.name}(${fn.params.join(', ')}).`,
    );
  }
  const locals: Record<string, unknown> = {};
  fn.params.forEach((p, i) => {
    locals[p] = argVals[i];
  });
  const fullMatchParams = ctx.matchParams ?? ctx.params;
  const declParams: Record<string, PathParamValue> = {};
  if (fn.declCaptures) {
    for (const key of fn.declCaptures) {
      if (Object.hasOwn(fullMatchParams, key)) {
        declParams[key] = fullMatchParams[key]!;
      }
    }
  }
  const bodyCtx: EvalCtx = {
    input: ctx.input,
    now: ctx.now,
    params: declParams,
    matchParams: fullMatchParams,
    scopeKind: fn.scopeKind ?? 'match',
    locals,
    funcs: fn.declScope ?? new Map(),
    firestoreLookup: ctx.firestoreLookup,
    firestoreAccesses: ctx.firestoreAccesses,
    expressionBudget: ctx.expressionBudget,
    observation: ctx.observation,
    trackedRoots: ctx.trackedRoots,
  };
  for (const b of fn.lets) {
    locals[b.name] = evalOperand(b.value, bodyCtx);
    bodyCtx.expressionBudget?.letBinding(b);
  }
  return evalExpr(fn.body, bodyCtx);
}

function evalGlobalCall(expr: Extract<Expr, { kind: 'call' }>, ctx: EvalCtx): unknown {
  const args = evalOperands(expr.args, ctx);
  if (expr.name === 'path') {
    if (isErr(args)) return args;
    if (args.length !== 1) {
      return new RuleError(`Incorrect number of arguments. Received: ${args.length}. Expected: path(string).`);
    }
    const inner = args[0];
    if (typeof inner === 'string') {
      if (inner.includes('//')) {
        return new RuleError('Invalid argument error in path(): empty path segment.');
      }
      return new StoragePath(inner);
    }
    return new RuleError(`path() expects a string, got ${describeType(inner)}.`);
  }
  const conversion = conversionFor(expr.name);
  if (!conversion) return new RuleError(`Function not found error: Name: [${expr.name}].`);
  if (isErr(args)) return args;
  const converted = applyConversion(conversion, args);
  if (converted instanceof ConversionFailure) return new RuleError(converted.message);
  return converted;
}
