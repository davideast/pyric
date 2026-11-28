// Unified in-process IR interpreter bridging Policy IR with @pyric/rules's Rules evaluator.
// Executes bounded ops (map, flatMap, select, any, all, count, fold, append),
// acyclic helper functions, for...of loops, and hardened module boundaries.
import type { Expression } from '../grammar/FirestoreAST.js';
import { EvalError, ExpressionLimitError, ResourceLimitError } from '../simulator/eval-error.js';
import { applyConversion, ConversionFailure, conversionFor } from '../simulator/conversions.js';
import { callValueMethod } from '../simulator/evaluation-builtins.js';
import { evaluate, evaluateBinding, isErrorValue, requireBoolean } from '../simulator/evaluator.js';
import { ExpressionBudget } from '../simulator/expression-budget.js';
import { applyMath, MathFailure } from '../simulator/math-builtins.js';
import { hostNumber, inInt64, INT64_MIN, isRulesInt, rulesFloatValue, rulesInt } from '../simulator/rules-int.js';
import { isRulesMap } from '../simulator/rules-type.js';
import { listElementsEqual } from '../simulator/value-equality.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import { Duration } from '../simulator/wrappers/duration.js';
import { RulesFloat } from '../simulator/wrappers/float.js';
import { Timestamp } from '../simulator/wrappers/timestamp.js';
import { FirestoreSet } from '../simulator/firestore-set.js';
import { MapDiff } from '../simulator/mapdiff.js';
import type { TraceRecorder } from '../simulator/trace-recorder.js';
import { evaluateLoop } from './for-of.js';
import {
  checkPolicyIR,
  RULES_CONVERSION_ARITIES,
  RULES_NAMESPACE_METHODS,
  STANDALONE_HELPER_ARITIES,
  type CheckedFunction,
  type CheckedPolicyIR,
} from './check.js';
import { isPureRulesExpr, parsePolicyIR, type IRBoundedOp, type IRExpr, type IRLetBinding } from './ir.js';

export type Scope = Record<string, unknown>;

export interface EvalIRContext {
  expressionBudget: ExpressionBudget;
  trace?: TraceRecorder;
  readValue?: (expr: Expression, value: unknown) => unknown;
  functions?: ReadonlyMap<string, CheckedFunction>;
  moduleMode?: boolean;
}

export function createPolicyContext(
  expressionLimit = 8192,
  functions?: ReadonlyMap<string, CheckedFunction>,
  moduleMode = false,
): EvalIRContext {
  return {
    expressionBudget: new ExpressionBudget(
      (_message, loc) => new ExpressionLimitError(`Policy evaluation exceeds ${expressionLimit} expression units`, loc),
      expressionLimit,
    ),
    functions,
    moduleMode,
  };
}

function invokeStandaloneHelper(name: string, args: unknown[]): unknown {
  const requireSafeInt = (v: unknown): number => {
    const i = rulesInt(v);
    if (i === undefined || i < -9007199254740991n || i > 9007199254740991n) {
      throw new EvalError('Expected an integer');
    }
    return Number(i);
  };
  switch (name) {
    case 'size': {
      const x = args[0];
      if (typeof x === 'string') return BigInt(x.length);
      if (Array.isArray(x)) return BigInt(x.length);
      if (isRulesMap(x)) return BigInt(Object.keys(x).length);
      if (x instanceof FirestoreSet) return BigInt(x.size());
      if (x instanceof Bytes) return BigInt(x.size());
      throw new EvalError('Expected a sized collection');
    }
    case 'replaceAt': {
      const [xs, idxVal, v] = args;
      if (!Array.isArray(xs)) throw new EvalError('Expected a list');
      const idx = requireSafeInt(idxVal);
      if (idx < 0 || idx >= xs.length) throw new EvalError('Index outside collection');
      const copy = [...xs];
      copy[idx] = v;
      return copy;
    }
    case 'range': {
      const n = requireSafeInt(args[0]);
      if (n < 0 || n > 256) throw new ResourceLimitError('Range bound exceeded');
      return Array.from({ length: n }, (_, i) => BigInt(i));
    }
    case 'locate': {
      const [xs, v] = args;
      if (typeof xs === 'string') {
        if (typeof v !== 'string') throw new EvalError('Expected a string');
        return BigInt(xs.indexOf(v));
      }
      if (!Array.isArray(xs)) throw new EvalError('Expected a list or string');
      for (let i = 0; i < xs.length; i++) if (listElementsEqual(xs[i], v)) return BigInt(i);
      return -1n;
    }
    case 'sorted': {
      const xs = args[0];
      if (!Array.isArray(xs)) throw new EvalError('Expected a list');
      if (!xs.every((v) => typeof v === 'string')) throw new EvalError('Expected strings');
      return [...xs].sort();
    }
    case 'chain': {
      const [xs, ys] = args;
      if (!Array.isArray(xs) || !Array.isArray(ys)) throw new EvalError('Expected two lists');
      if (xs.length + ys.length > 4096) throw new ResourceLimitError('List result bound exceeded');
      return xs.concat(ys);
    }
    case 'omit': {
      const [s, flag] = args;
      if (typeof s !== 'string' || typeof flag !== 'string') throw new EvalError('Expected strings');
      return s.replace(flag, '');
    }
    case 'fail': {
      const msg = args[0];
      if (typeof msg !== 'string') throw new EvalError('Expected a string');
      throw new Error(msg);
    }
    case 'abs': {
      const i = rulesInt(args[0]);
      if (i !== undefined) return i < 0n && i !== INT64_MIN ? -i : i;
      const f = rulesFloatValue(args[0]);
      if (f !== undefined) return new RulesFloat(Math.abs(f));
      throw new EvalError('Expected a number');
    }
    case 'sign': {
      const i = rulesInt(args[0]);
      if (i !== undefined) return i < 0n ? -1n : i > 0n ? 1n : 0n;
      const f = rulesFloatValue(args[0]);
      if (f !== undefined) return new RulesFloat(Math.sign(f));
      throw new EvalError('Expected a number');
    }
    case 'kind': {
      const x = args[0];
      if (Array.isArray(x)) return 'list';
      if (x === null) return 'null';
      if (isRulesInt(x) || rulesFloatValue(x) !== undefined) return 'number';
      if (x instanceof Bytes) return 'bytes';
      if (x instanceof Timestamp) return 'timestamp';
      if (x instanceof Duration) return 'duration';
      if (x instanceof FirestoreSet) return 'set';
      if (x instanceof MapDiff) return 'map_diff';
      return typeof x;
    }
    default:
      throw new EvalError('Unknown helper: ' + name);
  }
}

function invokeNamespace(space: string, method: string, args: unknown[]): unknown {
  if (space === 'math') {
    const res = applyMath(method, args);
    if (res instanceof MathFailure) throw new EvalError(res.message);
    return res;
  }
  if (space === 'timestamp') {
    if (method === 'value') {
      const ms = rulesInt(args[0]);
      if (ms === undefined) throw new EvalError('timestamp.value requires int');
      if (ms < -62135596800000n || ms > 253402300799999n) throw new EvalError('Timestamp out of range');
      return Timestamp.fromMillis(Number(ms));
    }
    if (method === 'date') {
      if (!args.every(isRulesInt)) throw new EvalError('timestamp.date requires ints');
      const [y, m, d] = args.map(Number) as [number, number, number];
      try { return Timestamp.fromYMD(y, m, d); } catch (e) { throw new EvalError((e as Error).message); }
    }
  }
  if (space === 'duration') {
    if (method === 'value') {
      const mag = rulesInt(args[0]);
      if (mag === undefined || typeof args[1] !== 'string') throw new EvalError('duration.value requires (int, string)');
      try { return Duration.fromValue(mag, args[1]); } catch (e) { throw new EvalError((e as Error).message); }
    }
    if (method === 'time') {
      if (!args.every(isRulesInt)) throw new EvalError('duration.time requires ints');
      const [h, m, s, n] = args as [bigint, bigint, bigint, bigint];
      try { return Duration.fromTime(h, m, s, n); } catch (e) { throw new EvalError((e as Error).message); }
    }
    if (method === 'abs') {
      if (!(args[0] instanceof Duration)) throw new EvalError('duration.abs requires duration');
      return Duration.abs(args[0]);
    }
  }
  throw new EvalError(`Unknown namespace method ${space}.${method}`);
}

export function evalBoundedOp(op: IRBoundedOp, ctx: EvalIRContext, scope: Scope): unknown {
  const items = evalIRExpr(op.list, ctx, scope);
  if (!Array.isArray(items)) throw new EvalError('bounded.' + op.op + ' requires a list');
  if (items.length > op.limit) throw new ResourceLimitError('Collection exceeds declared limit ' + op.limit);

  if (op.op === 'append') {
    const suffix = evalIRExpr(op.suffix, ctx, scope);
    if (!Array.isArray(suffix)) throw new EvalError('bounded.append requires two lists');
    if (items.length + suffix.length > op.limit) {
      throw new ResourceLimitError('Append exceeds declared limit ' + op.limit);
    }
    return [...items, ...suffix];
  }

  if (op.op === 'fold') {
    let result = evalIRExpr(op.initial, ctx, scope);
    for (const item of items) {
      ctx.expressionBudget.node();
      const local: Scope = Object.assign(Object.create(null), scope, { [op.accumulator]: result, [op.item]: item });
      for (const declaration of op.lets) evalIRLet(declaration, ctx, local);
      result = evalIRExpr(op.body, ctx, local);
    }
    return result;
  }

  const out: unknown[] = [];
  let total = 0;
  let firstError: EvalError | undefined;
  for (const item of items) {
    ctx.expressionBudget.node();
    const local: Scope = Object.assign(Object.create(null), scope, { [op.item]: item });
    let val: unknown;
    try {
      val = evalIRExpr(op.body, ctx, local);
      if (op.op === 'any' || op.op === 'all' || op.op === 'select' || op.op === 'count') {
        if (typeof val !== 'boolean') {
          throw new EvalError(op.op === 'count' ? 'Count predicate must return a boolean' : 'Expected a boolean');
        }
      }
      if (op.op === 'flatMap' && !Array.isArray(val)) throw new EvalError('Expected a list');
    } catch (error) {
      if (!isErrorValue(error)) throw error;
      firstError ??= error;
      continue;
    }
    if (op.op === 'any') { if (val === true) return true; }
    else if (op.op === 'all') { if (val === false) return false; }
    else if (op.op === 'count') { if (val === true) total++; }
    else if (op.op === 'select') { if (val === true) out.push(item); }
    else if (op.op === 'map') { out.push(val); }
    else {
      const part = val as unknown[];
      if (out.length + part.length > 4096) throw new ResourceLimitError('List result bound exceeded');
      out.push(...part);
    }
  }
  if (firstError) throw firstError;
  if (op.op === 'any') return false;
  if (op.op === 'all') return true;
  if (op.op === 'count') return ctx.moduleMode ? BigInt(total) : total;
  return out;
}

export function evalIRLet(binding: IRLetBinding, ctx: EvalIRContext, scope: Scope): void {
  try {
    scope[binding.name] = evalIRExpr(binding.value, ctx, scope);
  } catch (error) {
    if (!isErrorValue(error)) throw error;
    scope[binding.name] = error;
  }
}

function evalOperandsIR(exprs: readonly IRExpr[], ctx: EvalIRContext, scope: Scope): unknown[] {
  const vals = new Array<unknown>(exprs.length);
  let firstErr: EvalError | undefined;
  for (let i = 0; i < exprs.length; i++) {
    try { vals[i] = evalIRExpr(exprs[i]!, ctx, scope); }
    catch (e) { if (!isErrorValue(e)) throw e; firstErr ??= e; }
  }
  if (firstErr) throw firstErr;
  return vals;
}

function evalBindingIR(expr: IRExpr, ctx: EvalIRContext, scope: Scope): unknown {
  try { return evalIRExpr(expr, ctx, scope); }
  catch (e) { if (!isErrorValue(e)) throw e; return e; }
}

export function evalIRFunction(checked: CheckedFunction, args: unknown[], ctx: EvalIRContext): unknown {
  const { fn, loop } = checked;
  if (args.length !== fn.parameters.length) throw new Error(fn.name + ' argument count mismatch');
  const scope: Scope = Object.create(null);
  fn.parameters.forEach((p, i) => { scope[p] = args[i]; });
  for (const binding of fn.lets) evalIRLet(binding, ctx, scope);
  if (loop) {
    const pureFn = { name: fn.name, parameters: fn.parameters, exported: fn.exported, lets: [], body: fn.body as Expression };
    return evaluateLoop(pureFn, loop, ctx, scope);
  }
  return evalIRExpr(fn.body, ctx, scope);
}

/** Evaluate any IR expression under Rules-v2 semantics. */
export function evalIRExpr(expr: IRExpr, ctx: EvalIRContext, scope: Scope): unknown {
  if (isPureRulesExpr(expr) && !hasCustomCalls(expr, ctx)) {
    return evaluate(expr, ctx, scope);
  }
  if (expr.type === 'boundedOp') return evalBoundedOp(expr, ctx, scope);
  if (expr.type === 'functionCall') {
    const callee = ctx.functions?.get(expr.name);
    if (callee) {
      const boundArgs = expr.args.map((arg) => evalBindingIR(arg, ctx, scope));
      return evalIRFunction(callee, boundArgs, ctx);
    }
    const vals = evalOperandsIR(expr.args, ctx, scope);
    if (RULES_CONVERSION_ARITIES.has(expr.name)) {
      const res = applyConversion(conversionFor(expr.name)!, vals);
      if (res instanceof ConversionFailure) throw new EvalError(res.message);
      return res;
    }
    if (ctx.moduleMode && STANDALONE_HELPER_ARITIES.has(expr.name)) {
      return invokeStandaloneHelper(expr.name, vals);
    }
    throw new EvalError('Unknown function: ' + expr.name);
  }
  if (expr.type === 'methodCall') {
    if (
      ctx.moduleMode &&
      expr.object.type === 'identifier' &&
      !Object.hasOwn(scope, expr.object.name) &&
      Object.hasOwn(RULES_NAMESPACE_METHODS, expr.object.name)
    ) {
      const vals = evalOperandsIR(expr.args, ctx, scope);
      return invokeNamespace(expr.object.name, expr.method, vals);
    }
    const [recv, ...argVals] = evalOperandsIR([expr.object, ...expr.args], ctx, scope);
    return callValueMethod(recv, expr.method, argVals);
  }
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    const det = expr.op === '||';
    let lv: unknown, lErr: unknown;
    try { lv = requireBoolean(evalIRExpr(expr.left, ctx, scope), expr.left as Expression); }
    catch (e) { lErr = e; }
    if (lErr !== undefined && !isErrorValue(lErr)) throw lErr;
    if (lErr === undefined && lv === det) return det;
    let rv: unknown, rErr: unknown;
    try { rv = requireBoolean(evalIRExpr(expr.right, ctx, scope), expr.right as Expression); }
    catch (e) { rErr = e; }
    if (rErr !== undefined && !isErrorValue(rErr)) throw rErr;
    if (rErr === undefined && rv === det) return det;
    if (lErr !== undefined) throw lErr;
    if (rErr !== undefined) throw rErr;
    return rv;
  }
  if (expr.type === 'mapLiteral') {
    const keys: IRExpr[] = expr.entries.map((e) =>
      e.key.type === 'identifier' ? { type: 'literal', value: e.key.name, raw: JSON.stringify(e.key.name) } : e.key,
    );
    const vals = evalOperandsIR([...keys, ...expr.entries.map((e) => e.value)], ctx, scope);
    const half = expr.entries.length;
    const tempScope: Scope = Object.create(null);
    const entries: { key: Expression; value: Expression }[] = [];
    for (let i = 0; i < half; i++) {
      const k = vals[i];
      if (typeof k !== 'string') throw new EvalError('Map keys must be strings');
      if (FORBIDDEN_KEYS.has(k)) throw new EvalError('Missing own data value: forbidden key ' + k);
      const vn = '__v' + i;
      tempScope[vn] = vals[half + i];
      entries.push({ key: { type: 'literal', value: k, raw: JSON.stringify(k) }, value: { type: 'identifier', name: vn } });
    }
    return evaluate({ type: 'mapLiteral', entries }, ctx, tempScope);
  }
  if (expr.type === 'ternary') {
    const cond = requireBoolean(evalIRExpr(expr.condition, ctx, scope), expr.condition as Expression);
    return evalIRExpr(cond ? expr.consequent : expr.alternate, ctx, scope);
  }
  // Evaluate compound expression with inner custom calls or bounded ops by binding sub-results.
  return evalCompoundIR(expr, ctx, scope);
}

function hasCustomCalls(expr: IRExpr, ctx: EvalIRContext): boolean {
  if (expr.type === 'boundedOp' || expr.type === 'functionCall' || expr.type === 'mapLiteral' || expr.type === 'methodCall') {
    return true;
  }
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return false;
    case 'memberAccess':
      return hasCustomCalls(expr.object, ctx);
    case 'bracketAccess':
      return hasCustomCalls(expr.object, ctx) || hasCustomCalls(expr.index, ctx);
    case 'sliceAccess':
      return hasCustomCalls(expr.object, ctx) || hasCustomCalls(expr.start, ctx) || hasCustomCalls(expr.end, ctx);
    case 'binaryOp':
      return hasCustomCalls(expr.left, ctx) || hasCustomCalls(expr.right, ctx);
    case 'unaryOp':
      return hasCustomCalls(expr.operand, ctx);
    case 'ternary':
      return hasCustomCalls(expr.condition, ctx) || hasCustomCalls(expr.consequent, ctx) || hasCustomCalls(expr.alternate, ctx);
    case 'inExpr':
      return hasCustomCalls(expr.element, ctx) || hasCustomCalls(expr.collection, ctx);
    case 'isExpr':
      return hasCustomCalls(expr.value, ctx);
    case 'listLiteral':
      return expr.elements.some((e) => hasCustomCalls(e, ctx));
    case 'pathLiteral':
      return expr.segments.some((s) => typeof s !== 'string' && hasCustomCalls(s, ctx));
  }
}

function evalCompoundIR(expr: IRExpr, ctx: EvalIRContext, scope: Scope): unknown {
  const tempScope: Scope = Object.assign(Object.create(null), scope);
  let seq = 0;
  const sub = (child: IRExpr): Expression => {
    const key = '__ir_' + seq++;
    tempScope[key] = evalBindingIR(child, ctx, scope);
    return { type: 'identifier', name: key };
  };
  let rewritten: Expression;
  switch (expr.type) {
    case 'memberAccess':
      rewritten = { type: 'memberAccess', object: sub(expr.object), property: expr.property };
      break;
    case 'bracketAccess': {
      const idx = sub(expr.index);
      const obj = sub(expr.object);
      rewritten = { type: 'bracketAccess', object: obj, index: idx };
      break;
    }
    case 'sliceAccess':
      rewritten = { type: 'sliceAccess', object: sub(expr.object), start: sub(expr.start), end: sub(expr.end) };
      break;
    case 'binaryOp':
      rewritten = { type: 'binaryOp', op: expr.op, left: sub(expr.left), right: sub(expr.right) };
      break;
    case 'unaryOp':
      rewritten = { type: 'unaryOp', op: expr.op, operand: sub(expr.operand) };
      break;
    case 'inExpr': {
      const coll = sub(expr.collection);
      const elem = sub(expr.element);
      rewritten = { type: 'inExpr', element: elem, collection: coll };
      break;
    }
    case 'isExpr':
      rewritten = { type: 'isExpr', value: sub(expr.value), typeName: expr.typeName };
      break;
    case 'listLiteral':
      rewritten = { type: 'listLiteral', elements: expr.elements.map(sub) };
      break;
    case 'mapLiteral':
      rewritten = {
        type: 'mapLiteral',
        entries: expr.entries.map((e) => ({
          key: e.key.type === 'identifier' ? { type: 'literal', value: e.key.name, raw: JSON.stringify(e.key.name) } : sub(e.key),
          value: sub(e.value),
        })),
      };
      break;
    default:
      throw new EvalError('Unsupported IR expression: ' + expr.type);
  }
  return evaluate(rewritten, ctx, tempScope);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Sanitize and revive host input enforcing own-data, plain-prototype, key, and depth/node bounds. */
export function sanitizeHostInput(
  value: unknown,
  state: { nodes: number } = { nodes: 0 },
  depth = 0,
  keepSafeInt = false,
): unknown {
  if (++state.nodes > 16384 || depth > 32) throw new ResourceLimitError('Input depth or node bound exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    const typed = hostNumber(value);
    return !keepSafeInt && typeof typed === 'number' ? BigInt(typed) : typed;
  }
  if (typeof value === 'bigint') {
    if (!inInt64(value)) throw new EvalError('Integer value is out of range');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 4096) throw new ResourceLimitError('String bound exceeded');
    return value;
  }
  if (value instanceof RulesFloat && Object.getPrototypeOf(value) === RulesFloat.prototype) return value;
  if (value instanceof Bytes && Object.getPrototypeOf(value) === Bytes.prototype) return value;
  if (value instanceof Timestamp && Object.getPrototypeOf(value) === Timestamp.prototype) return value;
  if (value instanceof Duration && Object.getPrototypeOf(value) === Duration.prototype) return value;
  if (value instanceof Uint8Array) {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new EvalError('Expected plain bytes data');
    if (value.length > 65536) throw new ResourceLimitError('Bytes bound exceeded');
    if (Object.getOwnPropertySymbols(value).length) throw new EvalError('Expected plain data without symbols');
    for (const k of Object.getOwnPropertyNames(value)) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (d && !('value' in d)) throw new EvalError('Missing own data value');
    }
    return new Bytes(Uint8Array.prototype.slice.call(value));
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new EvalError('Expected plain list data');
    if (value.length > 4096) throw new ResourceLimitError('List bound exceeded');
    if (Object.getOwnPropertySymbols(value).length) throw new EvalError('Expected plain data without symbols');
    for (const k of Object.getOwnPropertyNames(value)) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (d && !('value' in d)) throw new EvalError('Missing own data value');
    }
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || !('value' in desc)) throw new EvalError('Missing own data value');
      out.push(sanitizeHostInput(desc.value, state, depth + 1, keepSafeInt));
    }
    return out;
  }
  if (!value || typeof value !== 'object') throw new EvalError('Expected plain data');
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) throw new EvalError('Expected plain record data');
  if (Object.getOwnPropertySymbols(value).length) throw new EvalError('Expected plain data without symbols');
  const out: Record<string, unknown> = Object.create(null);
  let count = 0;
  for (const key of Object.getOwnPropertyNames(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc)) throw new EvalError('Missing own data value');
    if (!desc.enumerable) continue;
    if (++count > 4096) throw new ResourceLimitError('Record size bound exceeded');
    if (key.length > 4096) throw new ResourceLimitError('String bound exceeded');
    if (FORBIDDEN_KEYS.has(key)) throw new EvalError('Missing own data value: forbidden key ' + key);
    Object.defineProperty(out, key, {
      value: sanitizeHostInput(desc.value, state, depth + 1, keepSafeInt),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Revive and harden transition host data (`before`/`after`/`input`) into Rules-v2-faithful types. */
export function revivePolicyValue(value: unknown, state: { nodes: number } = { nodes: 0 }): unknown {
  return sanitizeHostInput(value, state, 0, true);
}

function exportRulesValue(
  value: unknown,
  ctx: EvalIRContext,
  depth = 0,
  st: { nodes: number } = { nodes: 0 },
): unknown {
  if (++st.nodes > 16384 || depth > 64) throw new ResourceLimitError('Output depth or node bound exceeded');
  ctx.expressionBudget.node();
  if (typeof value === 'bigint') {
    return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value;
  }
  if (value instanceof RulesFloat) return value.value;
  if (value instanceof Bytes) return new Uint8Array(value.data);
  if (value instanceof Timestamp) return { __type: 'timestamp', seconds: value.seconds, nanos: value.nanos };
  if (value instanceof Duration) return { __type: 'duration', seconds: value.seconds, nanos: value.nanos };
  if (value instanceof FirestoreSet) return value.toArray().map((v) => exportRulesValue(v, ctx, depth + 1, st));
  if (Array.isArray(value)) return value.map((v) => exportRulesValue(v, ctx, depth + 1, st));
  if (isRulesMap(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: exportRulesValue(value[key], ctx, depth + 1, st),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Interpret a `use extension bounded;` module directly through the in-process Rules evaluator. */
export function interpretModule(
  source: string,
  { expressionLimit = 1000000 }: { expressionLimit?: number } = {},
): Record<string, (...args: unknown[]) => unknown> {
  const checked: CheckedPolicyIR = checkPolicyIR(parsePolicyIR(source, 'module'), { expressionLimit });
  const exportsObj: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of checked.exports) {
    const fn = checked.functions.get(name)!;
    exportsObj[name] = (...rawArgs: unknown[]) => {
      if (rawArgs.length !== fn.fn.parameters.length) throw new Error('Invalid argument count');
      const state = { nodes: 0 };
      const sanitized = rawArgs.map((arg) => sanitizeHostInput(arg, state));
      const ctx = createPolicyContext(expressionLimit, checked.functions, true);
      return exportRulesValue(evalIRFunction(fn, sanitized, ctx), ctx);
    };
  }
  return exportsObj;
}

export { evaluateBinding };
