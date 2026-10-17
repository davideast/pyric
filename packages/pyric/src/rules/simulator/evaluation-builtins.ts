import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { MapDiff } from './mapdiff.js';
import { FirestoreSet, SET_ALGEBRA_NAMES, SetMethodFailure, setMethod } from './firestore-set.js';
import { MAP_METHOD_NAMES, MapMethodFailure, mapList } from './map-keys.js';
import { compileRe2Regex, describeRulesType, isRulesMap, re2FullMatch, replaceRe2 } from './rules-type.js';
import { RulesValue, NO_OP } from './wrappers/base.js';
import { LatLng } from './wrappers/latlng.js';
import { Duration } from './wrappers/duration.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Bytes } from './wrappers/bytes.js';
import { Path } from './wrappers/path.js';
import { RulesFloat } from './wrappers/float.js';
import { EvalError, functionNotFoundMessage } from './eval-error.js';
import { ConversionFailure, applyConversion, conversionFor } from './conversions.js';
import { MathFailure, applyMath } from './math-builtins.js';
import { LIST_METHOD_NAMES, ListMethodFailure, listConcat, listJoin, listMembership, listRemoveAll } from './list-methods.js';
import { UnsupportedError } from './unsupported-error.js';
import { isDocumentPath, makeGetResource, normalizeDocumentPath, resolveExists, resolveGet } from './document-lookups.js';
import { chargeLookup } from './lookup-budget.js';
import type { SimulationContext } from './evaluation-context.js';
import { evaluate, evaluateBinding, evaluateOperands, isKnownGlobal } from './evaluator.js';
import { evaluateHashingMethod } from './hashing-builtins.js';
import { getFunctionScope } from './match-resolution.js';

function requireLookupPath(
  name: string,
  args: Expression[],
  ctx: SimulationContext,
  scope: Record<string, unknown>,
): string {
  if (args.length !== 1) {
    evaluateOperands(args, ctx, scope);
    throw new EvalError(`Incorrect number of arguments. Received: ${args.length}. Expected: ${name}(path).`);
  }
  const argVal = evaluate(args[0]!, ctx, scope);
  if (!(argVal instanceof Path) || argVal.segments.some((seg) => /^\{.*\}$/.test(seg))) {
    throw new EvalError(`Function not found error: Name: [${name}].`);
  }
  return String(argVal);
}

/**
 * The one normalization getAfter()/existsAfter() use for both the request
 * target (single write) and the batch projection, so a 1-op batch and a
 * single write resolve the same path the same way (FS-MET-6a). A leading
 * slash and the `/databases/(default)/documents` prefix name the same
 * document. A `.` or `..` segment errors: Firestore rejects both as document
 * ids, so such a path names no document.
 */
function afterLookupPath(name: 'getAfter' | 'existsAfter', pathStr: string): string {
  if (pathStr.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new EvalError(`${name}() path '${pathStr}' has a '.' or '..' segment, which is not a valid document id`);
  }
  const normalized = normalizeDocumentPath(pathStr);
  if (!isDocumentPath(normalized.split('/').filter(Boolean))) {
    throw new EvalError(
      `${name}() requires a path pointing to a document (even segment count), got '${normalized}'`,
    );
  }
  return normalized;
}

/** The request target in {@link afterLookupPath}'s normalized form. */
function afterTargetPath(ctx: SimulationContext): string {
  return normalizeDocumentPath(ctx.afterStatePath.toString());
}

// ═══ Function calls ═══

export function evaluateFunctionCall(
  name: string, args: Expression[],
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  // A user-defined function in scope shadows any global builtin of the same name.
  const fn = ctx.functions?.get(name);
  if (fn) {
    return invokeUserFunction(name, fn, args, ctx, scope);
  }

  // Built-in functions
  switch (name) {
    case 'get': {
      const path = requireLookupPath('get', args, ctx, scope);
      // Charge the per-request lookup budget BEFORE resolving so the 11th
      // distinct access fails closed even when the doc would resolve.
      chargeLookup(ctx, 'doc', path);
      return resolveGet(path, ctx);
    }
    case 'exists': {
      const path = requireLookupPath('exists', args, ctx, scope);
      chargeLookup(ctx, 'doc', path); // exists() shares get()'s per-path slot
      return resolveExists(path, ctx);
    }
    case 'getAfter': {
      const pathStr = requireLookupPath('getAfter', args, ctx, scope);
      const normalized = afterLookupPath('getAfter', pathStr);
      // getAfter() is a document access call and counts against the
      // per-request budget. 'after' keying: the post-write projection is a
      // different snapshot than get()'s pre-write read, so a path read by
      // both charges two slots. The fall-through resolveGet below does NOT
      // re-charge, because charging lives only here.
      chargeLookup(ctx, 'after', normalized);
      if (normalized === afterTargetPath(ctx)) {
        // RULES-B8: getAfter() of a doc that won't exist post-write (delete,
        // or projected-null) ERRORS like get() — guard with existsAfter().
        if (ctx.afterState === null) {
          throw new EvalError(`getAfter() of non-existent document '${pathStr}' (guard with existsAfter() first)`);
        }
        return makeGetResource(normalized, ctx.afterState);
      }
      if (ctx.batchProjection?.has(normalized)) {
        const projected = ctx.batchProjection.get(normalized)!;
        if (projected === null) {
          throw new EvalError(`getAfter() of non-existent document '${pathStr}' (guard with existsAfter() first)`);
        }
        return makeGetResource(normalized, projected);
      }
      return resolveGet(pathStr, ctx);
    }
    case 'existsAfter': {
      const pathStr = requireLookupPath('existsAfter', args, ctx, scope);
      const normalized = afterLookupPath('existsAfter', pathStr);
      // existsAfter() counts against the per-request lookup budget and
      // shares getAfter()'s post-write slot for the same path.
      chargeLookup(ctx, 'after', normalized);
      if (normalized === afterTargetPath(ctx)) {
        return ctx.existsAfter;
      }
      if (ctx.batchProjection?.has(normalized)) {
        return ctx.batchProjection.get(normalized) !== null;
      }
      return resolveExists(pathStr, ctx);
    }
    // NOTE: `debug()` is deliberately NOT handled here. Production Firestore
    // rejects it at compile ("Function not found error: Name: [debug]", the
    // captured acceptance probe for firestore.function.debug), so the local
    // evaluator must fail it the same way. Falling through to the
    // user-defined lookup below yields `EvalError('Unknown function: debug')`,
    // the exact message the conformance rejection-signature normalizer maps
    // to `function-not-found:debug`.
    // The conversion builtins share their semantics and error messages with
    // Storage rules; a failure is an absorbable evaluation error.
    case 'string':
    case 'int':
    case 'float': {
      const converted = applyConversion(conversionFor(name)!, evaluateOperands(args, ctx, scope));
      if (converted instanceof ConversionFailure) throw new EvalError(converted.message);
      return converted;
    }
    case 'path': {
      if (args.length !== 1) {
        evaluateOperands(args, ctx, scope);
        throw new EvalError(`Incorrect number of arguments. Received: ${args.length}. Expected: path(string).`);
      }
      const arg = evaluate(args[0]!, ctx, scope);
      if (typeof arg === 'string') return Path.fromString(arg);
      throw new EvalError(`path() requires a string argument, got ${typeof arg}`);
    }
  }

  throw new EvalError(`Unknown function: ${name}`);
}

function invokeUserFunction(
  name: string,
  fn: FunctionDef,
  args: Expression[],
  ctx: SimulationContext,
  scope: Record<string, unknown>,
): unknown {
  if (args.length !== fn.parameters.length) {
    evaluateOperands(args, ctx, scope);
    throw new EvalError(
      `Incorrect number of arguments. Received: ${args.length}. Expected: ${name}(${fn.parameters.join(', ')}).`,
    );
  }

  // Parameters evaluate in the caller's scope; the callee starts with a fresh
  // local scope containing only its own parameters and let bindings.
  const fnScope: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < fn.parameters.length; i++) {
    fnScope[fn.parameters[i]!] = evaluateBinding(args[i]!, ctx, scope);
  }

  // Resolve functions and path captures against the function's lexical
  // declaration scope when indexed (via collectRulesetScopes).
  const fnScopeInfo = getFunctionScope(fn);
  let fnCtx = ctx;
  if (fnScopeInfo) {
    const scopedVars: Record<string, string> = {};
    for (const key of fnScopeInfo.captures) {
      if (Object.hasOwn(ctx.pathVariables, key)) {
        scopedVars[key] = ctx.pathVariables[key]!;
      }
    }
    fnCtx = {
      ...ctx,
      functions: fnScopeInfo.functions as Map<string, FunctionDef>,
      pathVariables: scopedVars,
      database: fnScopeInfo.captures.has('database') ? ctx.database : '',
    };
  }

  ctx.trace?.enterFrame(name);
  try {
    for (const binding of fn.lets) {
      const bindingRootIdx = ctx.trace ? ctx.trace.entries.length : -1;
      fnScope[binding.name] = evaluateBinding(binding.value, fnCtx, fnScope);
      ctx.expressionBudget?.letBinding(binding);
      if (bindingRootIdx >= 0) {
        ctx.trace?.markEntryAsLetBinding(bindingRootIdx, binding.name);
      }
    }
    return evaluate(fn.body, fnCtx, fnScope);
  } finally {
    ctx.trace?.exitFrame();
  }
}

// ═══ Method calls ═══

export function evaluateMethodCall(
  objectExpr: Expression, method: string, args: Expression[],
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  if (objectExpr.type === 'identifier') {
    const name = objectExpr.name;
    if (isBuiltinNamespace(name) && !Object.hasOwn(scope, name) && !Object.hasOwn(ctx.pathVariables, name)) {
      const argValues = evaluateOperands(args, ctx, scope);
      ctx.expressionBudget?.node(objectExpr);
      return evaluateNamespaceMethod(name, method, argValues);
    }
    if (
      !isBuiltinNamespace(name)
      && !Object.hasOwn(scope, name)
      && !Object.hasOwn(ctx.pathVariables, name)
      && !isKnownGlobal(name)
    ) {
      throw new UnsupportedError(`Unknown namespace or method '${name}.${method}()'`);
    }
  }

  // The receiver, then every argument, evaluates when an earlier one errors.
  const [obj, ...argValues] = evaluateOperands([objectExpr, ...args], ctx, scope);

  if (obj instanceof RulesValue) {
    let result: unknown;
    try {
      result = obj.callMethod(method, argValues);
    } catch (e) {
      if (e instanceof EvalError) throw e;
      throw new EvalError((e as Error).message);
    }
    if (result === NO_OP) {
      if (
        method === 'size' ||
        method === 'toSet' ||
        LIST_METHOD_NAMES.has(method) ||
        SET_ALGEBRA_NAMES.has(method) ||
        MAP_METHOD_NAMES.has(method)
      ) {
        throw new EvalError(functionNotFoundMessage(method));
      }
      throw new UnsupportedError(`Unknown method '${method}' on ${obj.typeName}`);
    }
    if (obj instanceof LatLng && typeof result === 'number') {
      return new RulesFloat(result);
    }
    return result;
  }

  // MapDiff: obj.diff(other) → MapDiff
  if (method === 'diff' && isRulesMap(obj)) {
    if (argValues.length !== 1) {
      throw new EvalError(
        `Incorrect number of arguments. Received: ${argValues.length}. Expected: map.diff(map).`,
      );
    }
    const other = argValues[0];
    if (isRulesMap(other)) {
      return new MapDiff(other, obj);
    }
    throw new EvalError('diff() requires a map argument');
  }

  // Callable methods (from memberAccess returning a function)
  if (typeof obj === 'function') {
    return (obj as Function)(...argValues);
  }

  if (obj instanceof FirestoreSet) {
    const result = setMethod(obj, method, argValues);
    if (result instanceof SetMethodFailure) throw new EvalError(result.message);
    return result;
  }

  if (obj instanceof MapDiff) {
    switch (method) {
      case 'addedKeys':
      case 'removedKeys':
      case 'changedKeys':
      case 'affectedKeys':
      case 'unchangedKeys':
        if (argValues.length !== 0) {
          throw new EvalError(
            `Incorrect number of arguments. Received: ${argValues.length}. Expected: map_diff.${method}().`,
          );
        }
        return obj[method]();
    }
    throw new EvalError(functionNotFoundMessage(method));
  }

  if (isRulesMap(obj)) {
    const map = obj;
    switch (method) {
      case 'keys':
      case 'values': {
        const result = mapList(method, map, argValues);
        if (result instanceof MapMethodFailure) throw new EvalError(result.message);
        return result;
      }
      case 'size':
        if (argValues.length !== 0) {
          throw new EvalError(`Incorrect number of arguments. Received: ${argValues.length}. Expected: map.size().`);
        }
        return Object.keys(map).length;
      case 'get': {
        if (argValues.length !== 2) {
          throw new EvalError(
            `Incorrect number of arguments. Received: ${argValues.length}. Expected: map.get(string, any), map.get(list, any).`,
          );
        }
        const keyArg = argValues[0];
        const def = argValues[1];
        if (Array.isArray(keyArg)) {
          let cur: unknown = map;
          for (const seg of keyArg) {
            if (cur === null || cur === undefined) return def;
            if (typeof cur !== 'object' || Array.isArray(cur) || cur instanceof RulesValue) return def;
            const k = String(seg);
            if (!Object.hasOwn(cur as object, k)) return def;
            cur = (cur as Record<string, unknown>)[k];
          }
          return cur;
        }
        if (typeof keyArg !== 'string') {
          throw new EvalError(
            `Unsupported operation error. Received: map.get(${describeRulesType(keyArg)}, ${describeRulesType(def)}). Expected: map.get(string, any), map.get(list, any).`,
          );
        }
        return Object.hasOwn(map, keyArg) ? map[keyArg] : def;
      }
    }
  }

  if (Array.isArray(obj)) {
    switch (method) {
      case 'size':
        if (argValues.length !== 0) {
          throw new EvalError(`Incorrect number of arguments. Received: ${argValues.length}. Expected: list.size().`);
        }
        return obj.length;
      case 'hasAll':
      case 'hasAny':
      case 'hasOnly': {
        const result = listMembership(method, obj, argValues);
        if (result instanceof ListMethodFailure) throw new EvalError(result.message);
        return result;
      }
      case 'concat':
      case 'join':
      case 'removeAll': {
        let result: unknown;
        if (method === 'concat') result = listConcat(obj, argValues);
        else if (method === 'join') result = listJoin(obj, argValues);
        else result = listRemoveAll(obj, argValues);
        if (result instanceof ListMethodFailure) throw new EvalError(result.message);
        return result;
      }
      case 'toSet':
        if (argValues.length !== 0) {
          throw new EvalError(`Incorrect number of arguments. Received: ${argValues.length}. Expected: list.toSet().`);
        }
        return new FirestoreSet(obj);
    }
  }

  if (typeof obj === 'string') {
    switch (method) {
      case 'size':
      case 'lower':
      case 'upper':
      case 'trim':
      case 'toUtf8':
        if (argValues.length !== 0) {
          throw new EvalError(`Incorrect number of arguments. Received: ${argValues.length}. Expected: string.${method}().`);
        }
        if (method === 'size') return obj.length;
        if (method === 'lower') return obj.toLowerCase();
        if (method === 'upper') return obj.toUpperCase();
        if (method === 'trim') return obj.trim();
        return Bytes.fromUtf8(obj);
      case 'split':
      case 'matches': {
        if (argValues.length !== 1) {
          throw new EvalError(`Incorrect number of arguments. Received: ${argValues.length}. Expected: string.${method}(string).`);
        }
        const pattern = argValues[0];
        if (typeof pattern !== 'string') {
          throw new EvalError(
            `Unsupported operation error. Received: string.${method}(${describeRulesType(pattern)}). Expected: string.${method}(string).`,
          );
        }
        try {
          if (method === 'matches') return re2FullMatch(pattern, obj);
          return obj.split(compileRe2Regex('split', pattern, pattern, 'g'));
        } catch (e) {
          throw new EvalError((e as Error).message);
        }
      }
      case 'replace': {
        if (argValues.length !== 2) {
          throw new EvalError(
            `Incorrect number of arguments. Received: ${argValues.length}. Expected: string.replace(string, string).`,
          );
        }
        const [pattern, replacement] = argValues;
        if (typeof pattern !== 'string' || typeof replacement !== 'string') {
          throw new EvalError(
            `Unsupported operation error. Received: string.replace(${describeRulesType(pattern)}, ${describeRulesType(replacement)}). Expected: string.replace(string, string).`,
          );
        }
        try {
          return replaceRe2(obj, pattern, replacement);
        } catch (e) {
          throw new EvalError((e as Error).message);
        }
      }
    }
  }

  if (LIST_METHOD_NAMES.has(method) || SET_ALGEBRA_NAMES.has(method) || MAP_METHOD_NAMES.has(method)) {
    throw new EvalError(functionNotFoundMessage(method));
  }
  throw new EvalError(`Unknown method '${method}' on ${typeof obj}`);
}

const BUILTIN_NAMESPACES = new Set(['math', 'timestamp', 'duration', 'latlng', 'hashing']);

function isBuiltinNamespace(name: string): boolean {
  return BUILTIN_NAMESPACES.has(name);
}

function evaluateNamespaceMethod(ns: string, method: string, args: unknown[]): unknown {
  switch (ns) {
    case 'math': return evaluateMathMethod(method, args);
    case 'timestamp': return evaluateTimestampMethod(method, args);
    case 'duration': return evaluateDurationMethod(method, args);
    case 'latlng': return evaluateLatLngMethod(method, args);
    case 'hashing': return evaluateHashingMethod(method, args);
  }
  throw new UnsupportedError(`Unknown namespace '${ns}'`);
}

function unwrapFloat(v: unknown): unknown {
  return v instanceof RulesFloat ? v.value : v;
}

function evaluateLatLngMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'value': {
      if (args.length !== 2) {
        throw new EvalError(
          `Incorrect number of arguments. Received: ${args.length}. Expected: latlng.value(float, float).`,
        );
      }
      const lat = unwrapFloat(args[0]);
      const lng = unwrapFloat(args[1]);
      if (
        typeof lat !== 'number' || typeof lng !== 'number' ||
        !Number.isFinite(lat) || !Number.isFinite(lng)
      ) {
        throw new EvalError(
          `Unsupported operation error. Received: latlng.value(${describeRulesType(args[0])}, ${describeRulesType(args[1])}). Expected: latlng.value(float, float).`,
        );
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new EvalError(' Latitude must be in range [-90.0, +90.0] and longitude must be in range [-180.0, +180.0]');
      }
      return new LatLng(lat, lng);
    }
  }
  throw new UnsupportedError(`Unknown latlng method '${method}'`);
}

function evaluateMathMethod(method: string, args: unknown[]): unknown {
  const result = applyMath(method, args);
  if (result instanceof MathFailure) throw new EvalError(result.message);
  return result;
}

const MIN_TIMESTAMP_MILLIS = -62135596800000;
const MAX_TIMESTAMP_MILLIS = 253402300799999;

function evaluateTimestampMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'date': {
      if (args.length !== 3) {
        throw new EvalError(
          `Incorrect number of arguments. Received: ${args.length}. Expected: timestamp.date(int, int, int).`,
        );
      }
      if (!args.every((a) => typeof a === 'number' && Number.isInteger(a))) {
        throw new EvalError(
          `Unsupported operation error. Received: timestamp.date(${args.map(describeRulesType).join(', ')}). Expected: timestamp.date(int, int, int).`,
        );
      }
      const [y, m, d] = args as [number, number, number];
      try {
        return Timestamp.fromYMD(y, m, d);
      } catch (e) {
        throw new EvalError((e as Error).message);
      }
    }
    case 'value': {
      if (args.length !== 1) {
        throw new EvalError(
          `Incorrect number of arguments. Received: ${args.length}. Expected: timestamp.value(int).`,
        );
      }
      const ms = args[0];
      if (typeof ms !== 'number' || !Number.isInteger(ms)) {
        throw new EvalError(
          `Unsupported operation error. Received: timestamp.value(${describeRulesType(ms)}). Expected: timestamp.value(int).`,
        );
      }
      if (ms < MIN_TIMESTAMP_MILLIS || ms > MAX_TIMESTAMP_MILLIS) {
        throw new EvalError('Timestamp out of range');
      }
      return Timestamp.fromMillis(ms);
    }
  }
  throw new UnsupportedError(`Unknown timestamp method '${method}'`);
}

function evaluateDurationMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'value': {
      if (args.length !== 2) {
        throw new EvalError(
          `Incorrect number of arguments. Received: ${args.length}. Expected: duration.value(int, string).`,
        );
      }
      const [mag, unit] = args;
      if (typeof mag !== 'number' || !Number.isInteger(mag) || typeof unit !== 'string') {
        throw new EvalError(
          `Unsupported operation error. Received: duration.value(${describeRulesType(mag)}, ${describeRulesType(unit)}). Expected: duration.value(int, string).`,
        );
      }
      try {
        return Duration.fromValue(mag, unit);
      } catch (e) {
        throw new EvalError((e as Error).message);
      }
    }
    case 'time': {
      if (args.length !== 4) {
        throw new EvalError(
          `Incorrect number of arguments. Received: ${args.length}. Expected: duration.time(int, int, int, int).`,
        );
      }
      if (!args.every((a) => typeof a === 'number' && Number.isInteger(a))) {
        throw new EvalError(
          `Unsupported operation error. Received: duration.time(${args.map(describeRulesType).join(', ')}). Expected: duration.time(int, int, int, int).`,
        );
      }
      const [h, m, s, ns] = args as [number, number, number, number];
      return Duration.fromTime(h, m, s, ns);
    }
    case 'abs': {
      if (args.length !== 1) {
        throw new EvalError(
          `Incorrect number of arguments. Received: ${args.length}. Expected: duration.abs(duration).`,
        );
      }
      const d = args[0];
      if (!(d instanceof Duration)) {
        throw new EvalError(
          `duration.abs() requires a Duration argument, got ${typeof d}`,
        );
      }
      return Duration.abs(d);
    }
  }
  throw new UnsupportedError(`Unknown duration method '${method}'`);
}
