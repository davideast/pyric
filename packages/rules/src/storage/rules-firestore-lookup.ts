import type { Expr } from './rules.js';
import { evalExpr, evalOperand, evalOperands, type EvalCtx } from './rules-evaluator.js';
import {
  RuleEvalError,
  RuleResourceLimitError,
  RuleUnsupportedError,
} from './rules-evaluation-error.js';
import { StorageLatLng } from './rules-latlng.js';
import { StoragePath, interpolationSegments, isPathValue, pathValueSegments } from './rules-path.js';
import { describeRulesType as describeType } from '../simulator/rules-type.js';
import { lookupAccessKey, slashedSegment, slashedSegmentReason } from '../simulator/lookup-path.js';
import { RulesValue } from '../simulator/wrappers/base.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import { reviveFirestoreNumbers } from '../simulator/firestore-values.js';
import { hostNumber } from '../simulator/rules-int.js';
import { LatLng } from '../simulator/wrappers/latlng.js';
import { Path } from '../simulator/wrappers/path.js';
import { Reference } from '../simulator/wrappers/reference.js';
import { Timestamp } from '../simulator/wrappers/timestamp.js';
import {
  RuleError,
  isRuleError as isErr,
} from './rules-values.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * Wrap raw Firestore document data values into Storage rules values
 * (preserving RulesValue instances, typing numbers with `hostNumber`, and
 * wrapping GeoPoint/DocumentReference sentinels as StorageLatLng/StoragePath
 * without clobbering plain user maps that happen to carry `path` or
 * `latitude`/`longitude` alongside other fields).
 */
function wrapFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return hostNumber(val);
  if (val instanceof Date) {
    return Timestamp.fromMillis(val.getTime());
  }
  if (val instanceof Uint8Array) {
    return new Bytes(val);
  }
  if (val instanceof LatLng) {
    return new StorageLatLng(val.lat, val.lng);
  }
  if (val instanceof Path) {
    return StoragePath.fromSegments(val.segments, val.bindings);
  }
  if (val instanceof Reference) {
    return new StoragePath(
      val.path.length > 0
        ? `/databases/${val.databaseId}/documents/${val.path}`
        : `/databases/${val.databaseId}/documents`,
    );
  }
  if (val instanceof RulesValue) {
    return val;
  }
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      return val.map(wrapFirestoreValue);
    }
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (obj.__type === 'path') {
      if (Array.isArray(obj.segments)) {
        const bindings =
          typeof obj.bindings === 'object' && obj.bindings !== null && !Array.isArray(obj.bindings)
            ? Object.fromEntries(
                Object.entries(obj.bindings as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
              )
            : {};
        return StoragePath.fromSegments(obj.segments.map(String), bindings);
      }
      if (typeof obj.path === 'string') {
        return new StoragePath(obj.path.length > 1 ? obj.path.replace(/\/+$/, '') : obj.path);
      }
    }
    if ((obj.__type === 'reference' || obj.__type === 'ref') && typeof obj.path === 'string') {
      return storagePathFromReferenceString(obj.path);
    }
    if (
      typeof obj.__type === 'string' ||
      (typeof obj.type === 'string' && obj.type.startsWith('firestore/')) ||
      obj.__type__ === '__vector__'
    ) {
      const revived = reviveFirestoreNumbers(obj);
      if (revived instanceof RulesValue) {
        return wrapFirestoreValue(revived);
      }
    }
    const lat = obj.latitude ?? obj._latitude ?? (obj.__type === 'latlng' ? obj.lat : undefined);
    const lng = obj.longitude ?? obj._longitude ?? (obj.__type === 'latlng' ? obj.lng : undefined);
    if (
      (obj.__type === 'latlng' && typeof lat === 'number' && typeof lng === 'number') ||
      (keys.length === 2 && typeof lat === 'number' && typeof lng === 'number')
    ) {
      return new StorageLatLng(lat, lng);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      Object.defineProperty(out, k, {
        value: wrapFirestoreValue(v),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return val;
}

function storagePathFromReferenceString(rawPath: string): StoragePath {
  let trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  const projectsMatch = /^projects\/[^/]+\/(databases(?:\/.*)?)$/.exec(trimmed);
  if (projectsMatch) trimmed = projectsMatch[1]!;
  if (trimmed === 'databases' || trimmed.startsWith('databases/')) {
    return new StoragePath(`/${trimmed}`);
  }
  return new StoragePath(
    trimmed.length > 0
      ? `/databases/(default)/documents/${trimmed}`
      : '/databases/(default)/documents',
  );
}

export function evalFirestoreBuiltin(expr: MethodCall, ctx: EvalCtx): unknown {
  // The unit a namespace call costs beyond its argument, charged before the
  // path evaluates (no capture measures it after an erroring path).
  ctx.expressionBudget?.node(expr);
  if (expr.method !== 'get' && expr.method !== 'exists') {
    // Unknown namespace method, compile-reject class, never absorbed.
    throw new RuleUnsupportedError(`unsupported method firestore.${expr.method}()`);
  }
  if (expr.args.length !== 1) {
    evalOperands(expr.args, ctx);
    throw new RuleEvalError(`firestore.${expr.method}() expects a single path argument`);
  }
  if (!ctx.firestoreLookup) {
    if (ctx.observation) ctx.observation.readFirestore = true;
    // No sandbox-backed capability injected — keep the deny-with-reason
    // "unsupported" behavior; never a false allow.
    throw new RuleEvalError(
      `firestore.${expr.method}() is unsupported here — no Firestore lookup capability is configured`,
    );
  }
  const arg = expr.args[0];
  let docSegments: string[];
  if (arg.kind === 'path') {
    // An authored path literal charges one unit per literal segment in segment
    // order alongside its interpolations, then one node when the path completes.
    try {
      docSegments = buildFirestoreDocPath(arg, ctx, true);
    } catch (e) {
      if (!(e instanceof RuleResourceLimitError)) ctx.expressionBudget?.node(arg);
      throw e;
    }
    ctx.expressionBudget?.node(arg);
  } else {
    const val = evalExpr(arg, ctx);
    if (isErr(val)) return val;
    if (isPathValue(val)) {
      const segments = pathValueSegments(val).map((value) => ({ kind: 'literal' as const, value }));
      docSegments = buildFirestoreDocPath({ kind: 'path', segments }, ctx, false);
    } else {
      return new RuleError(
        `Function not found error: Name: [${expr.method}].`,
      );
    }
  }
  // A slashed lookup counts toward the two-document cap like any other:
  // production lists the errored call among the request's function calls.
  // Its key is encoded so it never counts as the deeper document.
  const accessKey = lookupAccessKey(docSegments);
  if (!ctx.firestoreAccesses.has(accessKey)) {
    if (ctx.firestoreAccesses.size >= 2) {
      // Resource-limit class, the same posture as the Firestore lookup
      // budget: production fails the whole evaluation closed, so a
      // determining &&/|| operand must NOT absorb this into an allow.
      throw new RuleResourceLimitError('firestore access limit exceeded: at most two distinct documents');
    }
    ctx.firestoreAccesses.add(accessKey);
  }
  const slashed = slashedSegment(docSegments);
  if (slashed !== undefined) {
    return new RuleError(`Service call error. Function: [firestore.${expr.method}]: ${slashedSegmentReason(slashed)}`);
  }
  const docPath = docSegments.join('/');
  if (ctx.observation) ctx.observation.readFirestore = true;
  if (expr.method === 'exists') {
    return ctx.firestoreLookup.exists(docPath);
  }
  const fields = ctx.firestoreLookup.get(docPath);
  if (fields === null) {
    // A missing get is a Rules error VALUE: it denies at the allow boundary,
    // but participates in COMMUTATIVE CEL error absorption in `&&`/`||`
    // (`error || true` allows, and `error && false` evaluates to false,
    // see the tri-state operand handling in rules-evaluator.ts).
    return new RuleError(`firestore.get() targeted a nonexistent document: ${docPath}`);
  }
  return { data: wrapFirestoreValue(fields) as Record<string, unknown> };
}

/**
 * Assemble a {@link PathArgSegment} list into the document path segments the
 * {@link FirestoreLookup} expects, then validate and strip the required
 * `/databases/<db>/documents/` prefix. Interpolations must resolve to a
 * string, number or path; anything else (e.g. `request.auth.uid` when auth is
 * null, which is undefined) throws, which denies.
 */
function buildFirestoreDocPath(
  pathExpr: Extract<Expr, { kind: 'path' }>,
  ctx: EvalCtx,
  chargeLiteralSegments: boolean,
): string[] {
  // Literal segments and interpolations evaluate in segment order; every
  // interpolation still evaluates when an earlier one errors, and the first
  // error denies.
  const parts: string[] = [];
  let errorMessage: string | undefined;
  for (const seg of pathExpr.segments) {
    if (seg.kind === 'literal') {
      if (chargeLiteralSegments) ctx.expressionBudget?.pathSegment(pathExpr);
      parts.push(seg.value);
      continue;
    }
    const v = evalOperand(seg.expr, ctx);
    if (isErr(v)) {
      errorMessage ??= v.message;
      continue;
    }
    const segments = interpolationSegments(v);
    if (segments === undefined) {
      errorMessage ??= `Firestore path interpolation resolved to ${describeType(v)} (expected a string or a path)`;
      continue;
    }
    parts.push(...segments);
  }
  if (errorMessage !== undefined) throw new RuleEvalError(errorMessage);
  // Required production shape: databases / <db> / documents / <doc path…>.
  if (parts.length < 4 || parts[0] !== 'databases' || parts[2] !== 'documents') {
    throw new RuleEvalError(
      `malformed Firestore path — expected /databases/<db>/documents/... , got /${parts.join('/')}`,
    );
  }
  if (parts[1] !== '(default)') {
    throw new RuleEvalError(
      `Storage rules may access only the default Firestore database, got ${parts[1]}`,
    );
  }
  const docSegments = parts.slice(3);
  // A document path is collection/doc pairs — an even, non-zero segment count.
  if (docSegments.length === 0 || docSegments.length % 2 !== 0) {
    throw new RuleEvalError(
      `Firestore path does not point at a document (needs an even segment count): ${docSegments.join('/')}`,
    );
  }
  return docSegments;
}
