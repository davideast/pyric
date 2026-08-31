import type { Expression } from '../grammar/FirestoreAST.js';
import { MapDiff } from './mapdiff.js';
import { FirestoreSet } from './firestore-set.js';
import { rulesValuesEqual } from './value-equality.js';
import { RulesValue, NO_OP } from './wrappers/base.js';
import { LatLng } from './wrappers/latlng.js';
import { Duration } from './wrappers/duration.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Bytes } from './wrappers/bytes.js';
import { Path } from './wrappers/path.js';
import { RulesFloat } from './wrappers/float.js';
import { EvalError } from './eval-error.js';
import { UnsupportedError } from './unsupported-error.js';
import { makeGetResource, normalizeDocumentPath, resolveExists, resolveGet } from './document-lookups.js';
import type { SimulationContext } from './evaluation-context.js';
import { evaluate, isKnownGlobal, resolveIdentifier } from './evaluator.js';
import { evaluateHashingMethod } from './hashing-builtins.js';

function rulesInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (v instanceof RulesFloat) return Math.trunc(v.value);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    // CEL parses the WHOLE string as an integer; a trailing non-digit (or any
    // float/garbage) is an error, not a salvaged prefix like parseInt gives.
    if (/^[+-]?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    throw new EvalError(`int() cannot convert string '${v}' to an integer`);
  }
  throw new EvalError(`int() cannot convert ${typeof v} to an integer`);
}

/** `float(x)` — produce a FLOAT (tagged) from a number, float, or numeric string. */
function rulesFloatBuiltin(v: unknown): RulesFloat {
  if (v instanceof RulesFloat) return v;
  if (typeof v === 'number') return new RulesFloat(v);
  if (typeof v === 'string') {
    const trimmed = v.trim();
    // Strict numeric form (optional sign, digits, optional fraction). Rejects
    // `'1.2.3'`, `'abc'`, trailing junk — all errors in prod.
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return new RulesFloat(parseFloat(trimmed));
    throw new EvalError(`float() cannot convert string '${v}' to a float`);
  }
  throw new EvalError(`float() cannot convert ${typeof v} to a float`);
}

// ═══ Function calls ═══

export function evaluateFunctionCall(
  name: string, args: Expression[],
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  // Built-in functions
  switch (name) {
    case 'get': {
      const path = String(evaluate(args[0], ctx, scope));
      return resolveGet(path, ctx);
    }
    case 'exists': {
      const path = String(evaluate(args[0], ctx, scope));
      return resolveExists(path, ctx);
    }
    case 'getAfter': {
      // Item 7 — projected post-write state.
      // For the document being written (matches request.path), return the
      // afterState. getafter-batch fix: for a SIBLING doc written earlier
      // (or later) in the same atomic batch/transaction, consult the
      // shared batchProjection map so the rule sees that write too — matches
      // production, where getAfter() reflects the whole batch's post-commit
      // state, not just the current op. Only once neither applies do we
      // fall through to get() (current committed data) for a doc the batch
      // doesn't touch.
      const argVal = evaluate(args[0], ctx, scope);
      const pathStr = String(argVal);
      const normalized = normalizeDocumentPath(pathStr);
      const segments = normalized.split('/').filter(Boolean);
      if (segments.length === 0 || segments.length % 2 !== 0) {
        throw new EvalError(
          `getAfter() requires a path pointing to a document (even segment count), got '${normalized}'`,
        );
      }
      if (pathStr === ctx.afterStatePath.toString()) {
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
      // Item 7 — projected existence after the write.
      // Same dispatch shape as getAfter: target path uses ctx.existsAfter,
      // sibling batch writes consult batchProjection, other paths fall
      // through to exists().
      const argVal = evaluate(args[0], ctx, scope);
      const pathStr = String(argVal);
      const normalized = normalizeDocumentPath(pathStr);
      const segments = normalized.split('/').filter(Boolean);
      if (segments.length === 0 || segments.length % 2 !== 0) {
        return false;
      }
      if (pathStr === ctx.afterStatePath.toString()) {
        return ctx.existsAfter;
      }
      if (ctx.batchProjection?.has(normalized)) {
        return ctx.batchProjection.get(normalized) !== null;
      }
      return resolveExists(pathStr, ctx);
    }
    case 'debug': {
      const val = evaluate(args[0], ctx, scope);
      return val; // debug() returns its argument
    }
    // RULES-B5 / RULES-B6: type-conversion builtins follow CEL's strict
    // semantics, not JS coercion. `String()` routes a RulesFloat through its
    // `.toString()` so `string(1.0)` → "1.0" (decimal preserved); bare ints
    // and other types stringify normally.
    case 'string': return String(evaluate(args[0], ctx, scope));
    case 'int': return rulesInt(evaluate(args[0], ctx, scope));
    case 'float': return rulesFloatBuiltin(evaluate(args[0], ctx, scope));
    case 'path': {
      // Item 5.4 — `path('users/alice')` returns a Path wrapper. Production
      // accepts only strings; passing an existing Path is a type error.
      const arg = evaluate(args[0], ctx, scope);
      if (typeof arg === 'string') return Path.fromString(arg);
      throw new EvalError(`path() requires a string argument, got ${typeof arg}`);
    }
  }

  // User-defined functions
  const fn = ctx.functions.get(name);
  if (!fn) throw new EvalError(`Unknown function: ${name}`);

  // Bind parameters — parameter expressions evaluate in the CALLER's
  // scope and frame. We push the inlinedFrom frame *after* this loop
  // so parameter traces stay attributed to the caller (where the
  // argument expression literally lives in source).
  const fnScope: Record<string, unknown> = { ...scope };
  for (let i = 0; i < fn.parameters.length; i++) {
    fnScope[fn.parameters[i]] = evaluate(args[i], ctx, scope);
  }

  // Push frame for let bindings + body so their trace entries get
  // tagged `inlinedFrom: { name }`. try/finally so an evaluation
  // error still pops the frame and doesn't pollute sibling rules.
  ctx.trace?.enterFrame(name);
  try {
    // Evaluate let bindings. Capture the trace entries' next-write
    // position BEFORE the binding's expression evaluates — that slot
    // will be the binding-root entry (recursive children land below
    // it). After the evaluate returns, tag that root slot with the
    // bound name so the agent can attribute "this subtree was the
    // value of `<name>`" without re-walking the function AST.
    for (const binding of fn.lets) {
      const bindingRootIdx = ctx.trace ? ctx.trace.entries.length : -1;
      fnScope[binding.name] = evaluate(binding.value, ctx, fnScope);
      if (bindingRootIdx >= 0) {
        ctx.trace?.markEntryAsLetBinding(bindingRootIdx, binding.name);
      }
    }

    // Evaluate body
    return evaluate(fn.body, ctx, fnScope);
  } finally {
    ctx.trace?.exitFrame();
  }
}

// ═══ Method calls ═══

export function evaluateMethodCall(
  objectExpr: Expression, method: string, args: Expression[],
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  // Built-in namespaces (math, timestamp, duration) are not first-class
  // values — they exist only as method-call targets. Dispatch them before
  // calling evaluate(objectExpr), which would resolve the identifier to
  // undefined and fall through to "Unknown method on undefined".
  // Skip the dispatch if the namespace name is shadowed by a local binding
  // or path variable.
  if (objectExpr.type === 'identifier') {
    const name = objectExpr.name;
    if (isBuiltinNamespace(name) && !(name in scope) && !(name in ctx.pathVariables)) {
      const argValues = args.map(a => evaluate(a, ctx, scope));
      return evaluateNamespaceMethod(name, method, argValues);
    }
    // RULES-B2 interaction: an UNKNOWN bare identifier used as a method-call
    // target (e.g. `foo.bar()`) is most likely a namespace the simulator
    // hasn't implemented, not a typo'd value. Resolving it as a value now
    // throws "Undefined variable" (RULES-B2), but we want the agent-facing
    // UNSUPPORTED signal ("sim gap") here rather than a hard ERROR — that's
    // the deliberate affordance the old `undefined.method()` path provided.
    // (Bare `foo` used as a VALUE still errors via resolveIdentifier; only the
    // method-call-target case is lifted to UNSUPPORTED.)
    if (
      !isBuiltinNamespace(name)
      && !(name in scope)
      && !(name in ctx.pathVariables)
      && !isKnownGlobal(name)
    ) {
      throw new UnsupportedError(`Unknown namespace or method '${name}.${method}()'`);
    }
  }

  const obj = evaluate(objectExpr, ctx, scope);
  const argValues = args.map(a => evaluate(a, ctx, scope));

  // RulesValue method dispatch (Item 0.B hook 3). Placed above MapDiff /
  // FirestoreSet / Map / Array / String branches because every wrapper
  // is also `typeof === 'object'` — without this short-circuit, a
  // Timestamp would fall into the Map branch and dispatch `.size()` on
  // its private `{seconds, nanos}` shape. NO_OP from the wrapper means
  // "I don't have this method" → UnsupportedError, which the handler
  // maps to TestResult.state = 'UNSUPPORTED' (Item 0.A) so agents see
  // a sim gap rather than a silent DENY.
  if (obj instanceof RulesValue) {
    const result = obj.callMethod(method, argValues);
    if (result === NO_OP) {
      throw new UnsupportedError(`Unknown method '${method}' on ${obj.typeName}`);
    }
    return result;
  }

  // MapDiff: obj.diff(other) → MapDiff
  if (method === 'diff' && typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const other = argValues[0];
    if (typeof other === 'object' && other !== null) {
      return new MapDiff(other as Record<string, unknown>, obj as Record<string, unknown>);
    }
    throw new EvalError('diff() requires a map argument');
  }

  // Callable methods (from memberAccess returning a function)
  if (typeof obj === 'function') {
    return (obj as Function)(...argValues);
  }

  // FirestoreSet methods
  if (obj instanceof FirestoreSet) {
    switch (method) {
      case 'hasOnly': return obj.hasOnly(argValues[0] as unknown[] | FirestoreSet);
      case 'hasAll': return obj.hasAll(argValues[0] as unknown[] | FirestoreSet);
      case 'hasAny': return obj.hasAny(argValues[0] as unknown[] | FirestoreSet);
      case 'size': return obj.size();
      case 'difference':
      case 'union':
      case 'intersection': {
        const other = argValues[0];
        if (!(other instanceof FirestoreSet)) {
          throw new EvalError(`Unsupported operation: set.${method} requires a Set argument`);
        }
        return obj[method](other);
      }
    }
  }

  // MapDiff methods (when called directly, not via memberAccess)
  if (obj instanceof MapDiff) {
    switch (method) {
      case 'addedKeys': return obj.addedKeys();
      case 'removedKeys': return obj.removedKeys();
      case 'changedKeys': return obj.changedKeys();
      case 'affectedKeys': return obj.affectedKeys();
      case 'unchangedKeys': return obj.unchangedKeys();
    }
  }

  // Map/object methods
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const map = obj as Record<string, unknown>;
    switch (method) {
      // Production Map.keys() returns a List, not a Set. List membership
      // methods work on it, but Set-only algebra requires an explicit toSet().
      case 'keys': return Object.keys(map);
      case 'values': return Object.values(map);
      case 'size': return Object.keys(map).length;
      case 'diff': {
        const other = argValues[0] as Record<string, unknown>;
        return new MapDiff(other, map);
      }
      case 'get': {
        // Map.get(key, default) — Item 3 (REBUILD_PLAN.md).
        // Two forms (production behavior locked in by 0.H parity probe):
        //   m.get('a', default)           → m.a if present, else default
        //   m.get(['a','b','c'], default) → m.a.b.c if full walk succeeds, else default
        // Production *always* returns default on any walk failure (missing
        // key, non-map intermediate, etc.). It does NOT distinguish "key
        // missing" from "intermediate missing" — both collapse to default.
        // An explicit `null` value at the leaf is returned as null (not
        // default), since the key is present.
        const keyArg = argValues[0];
        const def = argValues[1];
        if (Array.isArray(keyArg)) {
          // List-form nested traversal
          let cur: unknown = map;
          for (const seg of keyArg) {
            if (cur === null || cur === undefined) return def;
            // Cannot descend into non-maps (string, number, list, wrapper).
            // Probe scenarios list_form_mid_is_string / list_form_mid_is_int
            // confirmed prod returns default in these cases.
            if (typeof cur !== 'object' || Array.isArray(cur) || cur instanceof RulesValue) return def;
            const k = String(seg);
            if (!Object.hasOwn(cur as object, k)) return def; // RULES-B7: own keys only
            cur = (cur as Record<string, unknown>)[k];
          }
          return cur;
        }
        // Single-key form
        const k = String(keyArg);
        return Object.hasOwn(map, k) ? map[k] : def; // RULES-B7: own keys only
      }
    }
  }

  // List methods
  if (Array.isArray(obj)) {
    switch (method) {
      case 'size': return obj.length;
      // RULES-B9: list membership uses VALUE equality, not JS identity, so it
      // is consistent with `in` / `removeAll` (which already use
      // rulesValuesEqual). Without this, `[t1].hasAll([t2])` for equal-valued
      // Timestamp/Bytes/Path wrappers wrongly returned false because the two
      // instances aren't `===`.
      case 'hasAll': return (argValues[0] as unknown[]).every(v => obj.some(o => rulesValuesEqual(o, v)));
      case 'hasAny': return (argValues[0] as unknown[]).some(v => obj.some(o => rulesValuesEqual(o, v)));
      case 'hasOnly': {
        const allowed = argValues[0] as unknown[];
        return obj.every(v => allowed.some(o => rulesValuesEqual(o, v)));
      }
      case 'join': return obj.join(String(argValues[0] ?? ','));
      // ─── Item 5.2: List.concat / removeAll / toSet ─────────────────────
      case 'concat': {
        const other = argValues[0];
        if (!Array.isArray(other)) {
          throw new EvalError(`List.concat requires a list argument, got ${typeof other}`);
        }
        return [...obj, ...other];
      }
      case 'removeAll': {
        // Returns a new list with all items from `other` removed (by value
        // equality). Uses rulesValuesEqual so wrapper instances (Timestamp,
        // Duration, etc.) compare by value, not by JS identity — without
        // this, `[t1].removeAll([t2])` where t1 and t2 are equal Timestamp
        // wrappers would not remove t1.
        const other = argValues[0];
        if (!Array.isArray(other)) {
          throw new EvalError(`List.removeAll requires a list argument, got ${typeof other}`);
        }
        return obj.filter(v => !other.some(o => rulesValuesEqual(v, o)));
      }
      case 'toSet': {
        // Sets preserve Rules values and deduplicate by Rules value equality;
        // numeric 1 and string '1' remain distinct, matching production.
        return new FirestoreSet(obj);
      }
      case 'difference':
      case 'union':
      case 'intersection':
        throw new EvalError(`Function not found on List receiver: ${method}`);
    }
  }

  // String methods
  if (typeof obj === 'string') {
    switch (method) {
      case 'size': return obj.length;
      case 'lower': return obj.toLowerCase();
      case 'upper': return obj.toUpperCase();
      case 'trim': return obj.trim();
      // RULES-B4: split()/matches()/replace() take RE2 *regular expressions*
      // and matches() is a FULL-STRING (anchored) test — production: "returns
      // true if the whole string matches the regex". The previous impl used a
      // partial JS `.test()`, a literal-string `split`, and a first-only
      // `replace`. We compile via the JS RegExp engine (RE2 and JS share the
      // common subset used by rules; exotic RE2-only constructs are a noted
      // limitation, not a behavior divergence for the documented cases) and
      // anchor matches() with `^(?:…)$`, apply `g` to replace/split.
      case 'split': return obj.split(compileRulesRegex(String(argValues[0]), 'g'));
      case 'matches':
        return compileRulesRegex(`^(?:${String(argValues[0])})$`).test(obj);
      case 'replace':
        return obj.replace(compileRulesRegex(String(argValues[0]), 'g'), String(argValues[1]));
      case 'toUtf8': return Bytes.fromUtf8(obj); // Item 5.3 — only producer of Bytes from a literal.
    }
  }

  throw new EvalError(`Unknown method '${method}' on ${typeof obj}`);
}

/**
 * Compile a Firestore-rules regex (RULES-B4). Rules regexes follow RE2
 * syntax; we use the JS RegExp engine, which shares the common subset rules
 * actually use. A pattern the engine can't compile is a real type error in
 * the rule (not a sim gap) → EvalError so the handler DENYs, matching
 * production's "invalid regex → error" behavior.
 */
function compileRulesRegex(pattern: string, flags = ''): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new EvalError(`Invalid regex '${pattern}': ${(e as Error).message}`);
  }
}

// ═══ Built-in namespaces (math, timestamp, duration) ═══
//
// Production parity: these used to throw via the "Unknown method on
// undefined" path because the identifiers `math` / `timestamp` / `duration`
// resolve to undefined. The throw was caught by handler.ts and counted as
// deny — silently denying every ALLOW case that touched a math/time
// built-in. Confirmed by parity-stress-integration.test.ts (Scenario 1).
//
// We model timestamp values and duration values as plain numbers
// (milliseconds since epoch and milliseconds, respectively). That lets
// JavaScript's `<`, `>`, `<=`, `>=`, `+`, `-` work without a wrapper
// class. This is sufficient for any rule whose timestamp/duration values
// originate from the namespace built-ins themselves.

const BUILTIN_NAMESPACES = new Set(['math', 'timestamp', 'duration', 'latlng', 'hashing']);

function isBuiltinNamespace(name: string): boolean {
  return BUILTIN_NAMESPACES.has(name);
}

function evaluateNamespaceMethod(ns: string, method: string, args: unknown[]): unknown {
  // RULES-B5: the numeric namespaces (math/latlng/timestamp/duration) operate
  // on the underlying double — `latlng.value(37.7, ...)` or `math.ceil(1.5)`
  // doesn't care whether the arg was written as an int or a float literal, and
  // the constructors store bare numbers. Unwrap RulesFloat args to their raw
  // value so `args[0] as number` casts inside each handler stay valid (a
  // RulesFloat is otherwise an object, breaking `latlng.value` equality etc.).
  // hashing.* takes Bytes/String — no numeric args — so it's left untouched.
  const a = ns === 'hashing' ? args : args.map(unwrapFloat);
  switch (ns) {
    case 'math': return evaluateMathMethod(method, a);
    case 'timestamp': return evaluateTimestampMethod(method, a);
    case 'duration': return evaluateDurationMethod(method, a);
    case 'latlng': return evaluateLatLngMethod(method, a);
    case 'hashing': return evaluateHashingMethod(method, args);
  }
  throw new UnsupportedError(`Unknown namespace '${ns}'`);
}

/** RULES-B5: collapse a RulesFloat to its raw double; pass everything else through. */
function unwrapFloat(v: unknown): unknown {
  return v instanceof RulesFloat ? v.value : v;
}

// ─── hashing.* (Item 5.3) ───────────────────────────────────────────────
//
// Per docs (rules.hashing): crc32, crc32c, md5, sha256.
// All accept Bytes | String; strings are hashed as UTF-8 bytes.
// All return Bytes (round-trips with Bytes.toBase64() / .toHexString()).
//
// md5 / sha256 use node:crypto (CLAUDE.md: dev tools must use node:* APIs).
// crc32 (IEEE 802.3) and crc32c (Castagnoli) are implemented inline via
// table lookup since no crc dep is in the SDK.

function evaluateLatLngMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'value': {
      // latlng.value(lat, lng) → LatLng wrapper. Item 1.1 closes the
      // entire `latlng` namespace gap (was throwing UnsupportedError).
      const [lat, lng] = args as [number, number];
      return new LatLng(lat, lng);
    }
  }
  throw new UnsupportedError(`Unknown latlng method '${method}'`);
}

function evaluateMathMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'abs': return Math.abs(args[0] as number);
    case 'ceil': return Math.ceil(args[0] as number);
    case 'floor': return Math.floor(args[0] as number);
    case 'round': return Math.round(args[0] as number);
    case 'sqrt': return Math.sqrt(args[0] as number);
    case 'pow': return Math.pow(args[0] as number, args[1] as number);
    case 'isNaN': return Number.isNaN(args[0] as number);
  }
  throw new EvalError(`Unknown math method '${method}'`);
}

function evaluateTimestampMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'date': {
      // timestamp.date(year, month, day) → Timestamp at midnight UTC.
      // Item 1.3 flip: was returning epoch-ms Number which broke
      // `is timestamp` and dropped sub-second precision under arithmetic.
      const [y, m, d] = args as [number, number, number];
      return Timestamp.fromYMD(y, m, d);
    }
    case 'value': {
      // timestamp.value(epochMillis) → Timestamp wrapper. Item 1.3 flip.
      return Timestamp.fromMillis(args[0] as number);
    }
  }
  throw new UnsupportedError(`Unknown timestamp method '${method}'`);
}

function evaluateDurationMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'value': {
      // duration.value(magnitude, unit) → Duration wrapper. Item 1.2 flip:
      // was returning a millis Number, which silently lost sub-ms precision
      // and made `is duration` always false. Item 1.0 dispatch hooks +
      // Duration.binaryOp keep arithmetic and comparison working without
      // numeric coercion.
      try {
        return Duration.fromValue(args[0] as number, args[1] as string);
      } catch (e) {
        // Bad unit string is a real type error in the rule, not a sim gap.
        throw new EvalError((e as Error).message);
      }
    }
    case 'time': {
      const [h, m, s, ns] = args as [number, number, number, number];
      return Duration.fromTime(h, m, s, ns);
    }
    case 'abs': {
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
