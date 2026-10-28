import type { Expr } from './rules.js';
import { evalExpr, evalOperands, type EvalCtx } from './rules-evaluator.js';
import {
  RuleEvalError,
  RuleResourceLimitError,
  RuleUnsupportedError,
} from './rules-evaluation-error.js';
import { StorageLatLng } from './rules-latlng.js';
import { StoragePath } from './rules-path.js';
import { describeRulesType as describeType } from '../../rules/simulator/rules-type.js';
import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import { Bytes } from '../../rules/simulator/wrappers/bytes.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { LatLng } from '../../rules/simulator/wrappers/latlng.js';
import { Path } from '../../rules/simulator/wrappers/path.js';
import { Timestamp } from '../../rules/simulator/wrappers/timestamp.js';
import {
  RuleError,
  isRuleError as isErr,
} from './rules-values.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * Wrap raw Firestore document data values into Storage rules values
 * (preserving RulesValue instances, wrapping floats in RulesFloat, and
 * wrapping GeoPoint/DocumentReference sentinels as StorageLatLng/StoragePath
 * without clobbering plain user maps that happen to carry `path` or
 * `latitude`/`longitude` alongside other fields).
 */
function wrapFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'number') {
    return Number.isInteger(val) ? val : new RulesFloat(val);
  }
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
    return new StoragePath(val.toString());
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
    const lat = obj.latitude ?? obj._latitude;
    const lng = obj.longitude ?? obj._longitude;
    if (
      obj.__type === 'latlng' ||
      (keys.length === 2 && typeof lat === 'number' && typeof lng === 'number')
    ) {
      return new StorageLatLng(lat as number, lng as number);
    }
    if (
      obj.__type === 'path' ||
      (keys.length === 1 && typeof obj.path === 'string' && obj.path.startsWith('/databases/'))
    ) {
      return new StoragePath(obj.path as string);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = wrapFirestoreValue(v);
    }
    return out;
  }
  return val;
}

export function evalFirestoreBuiltin(expr: MethodCall, ctx: EvalCtx): unknown {
  // The unit a namespace call costs beyond its argument, charged before the
  // path evaluates (no capture measures it after an erroring path).
  ctx.expressionBudget?.node(expr);
  if (expr.method !== 'get' && expr.method !== 'exists') {
    // Unknown namespace method, compile-reject class, never absorbed.
    throw new RuleUnsupportedError(`unsupported method firestore.${expr.method}()`);
  }
  if (!ctx.firestoreLookup) {
    // No sandbox-backed capability injected — keep the deny-with-reason
    // "unsupported" behavior; never a false allow.
    throw new RuleEvalError(
      `firestore.${expr.method}() is unsupported here — no Firestore lookup capability is configured`,
    );
  }
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`firestore.${expr.method}() expects a single path argument`);
  }
  const arg = expr.args[0];
  let docSegments: string[];
  if (arg.kind === 'path') {
    // An authored path literal is an evaluated node plus one unit per literal
    // segment; its interpolations charge themselves as they evaluate.
    ctx.expressionBudget?.node(arg);
    for (const seg of arg.segments) if (seg.kind === 'literal') ctx.expressionBudget?.pathSegment(arg);
    docSegments = buildFirestoreDocPath(arg, ctx);
  } else {
    const val = evalExpr(arg, ctx);
    if (isErr(val)) return val;
    if (isPathValue(val)) {
      const segments = pathValueSegments(val).map((value) => ({ kind: 'literal' as const, value }));
      docSegments = buildFirestoreDocPath({ kind: 'path', segments }, ctx);
    } else {
      return new RuleError(
        `Function not found error: Name: [${expr.method}].`,
      );
    }
  }
  // A slashed lookup counts toward the two-document cap like any other:
  // production lists the errored call among the request's function calls.
  // Its key is encoded so it never counts as the deeper document.
  const accessKey = docSegments.map(accessKeySegment).join('/');
  if (!ctx.firestoreAccesses.has(accessKey)) {
    if (ctx.firestoreAccesses.size >= 2) {
      // Resource-limit class, the same posture as the Firestore lookup
      // budget: production fails the whole evaluation closed, so a
      // determining &&/|| operand must NOT absorb this into an allow.
      throw new RuleResourceLimitError('firestore access limit exceeded: at most two distinct documents');
    }
    ctx.firestoreAccesses.add(accessKey);
  }
  const slashed = docSegments.find((segment) => segment.includes('/'));
  if (slashed !== undefined) {
    // No document ID holds a `/`. The capture
    // `rules-storage-h1-lookup-interpolated-slash` shows the call erroring
    // for `get` and `exists` alike, but under the Rules Test API, where an
    // unmocked call also errors. That `exists` errors rather than answering
    // false against a real database is inferred, and erroring is the
    // fail-closed reading: `!exists(...)` denies.
    return new RuleError(
      `Service call error. Function: [firestore.${expr.method}]: the path segment "${slashed}" holds a "/", ` +
        'and an interpolated string is one segment, so no document has this path',
    );
  }
  const docPath = docSegments.join('/');
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

/** Whether a rules value has the rules type `path`. */
function isPathValue(value: unknown): value is RulesValue {
  return value instanceof StoragePath || (value instanceof RulesValue && value.typeName === 'path');
}

function pathValueSegments(value: RulesValue): string[] {
  if (value instanceof StoragePath) return value.segments;
  return String(value).split('/').filter(Boolean);
}

/**
 * One segment of the key that counts distinct documents. A segment holding a
 * `/` is percent-encoded, as production's own argument rendering shows
 * (`users/alice%2Fprivate%2Fx`), so it never counts as the deeper document.
 */
function accessKeySegment(segment: string): string {
  return segment.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/**
 * The segments one interpolation contributes. Production decides by the
 * value's rules type, not its contents: a string or number is exactly one
 * segment, even when it holds a `/`, and a `path` value (a `{rest=**}`
 * capture or `path()`) splices in as its segments
 * (capture `rules-storage-storage-lookup-path-interpolation`).
 */
function interpolatedSegments(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (isPathValue(value)) return pathValueSegments(value);
  throw new RuleEvalError(
    `Firestore path interpolation resolved to ${describeType(value)} (expected a string or a path)`,
  );
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
): string[] {
  // Every interpolation evaluates when an earlier one errors; the first
  // error denies.
  const interpolated = evalOperands(pathExpr.segments.flatMap((seg) => (seg.kind === 'literal' ? [] : [seg.expr])), ctx);
  if (isErr(interpolated)) throw new RuleEvalError(interpolated.message);
  let next = 0;
  const parts = pathExpr.segments.flatMap((seg) => {
    if (seg.kind === 'literal') return [seg.value];
    return interpolatedSegments(interpolated[next++]);
  });
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
