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
  let docPath: string;
  if (arg.kind === 'path') {
    // An authored path literal is an evaluated node plus one unit per literal
    // segment; its interpolations charge themselves as they evaluate.
    ctx.expressionBudget?.node(arg);
    for (const seg of arg.segments) if (seg.kind === 'literal') ctx.expressionBudget?.pathSegment(arg);
    docPath = buildFirestoreDocPath(arg, ctx);
  } else {
    const val = evalExpr(arg, ctx);
    if (isErr(val)) return val;
    if (val instanceof StoragePath || (val instanceof RulesValue && val.typeName === 'path')) {
      const pathString = val instanceof StoragePath ? val.path : String(val);
      const segments = pathString.split('/').filter(Boolean).map((value) => ({ kind: 'literal' as const, value }));
      docPath = buildFirestoreDocPath({ kind: 'path', segments }, ctx);
    } else {
      return new RuleError(
        `Function not found error: Name: [${expr.method}].`,
      );
    }
  }
  if (!ctx.firestoreAccesses.has(docPath)) {
    if (ctx.firestoreAccesses.size >= 2) {
      // Resource-limit class, the same posture as the Firestore lookup
      // budget: production fails the whole evaluation closed, so a
      // determining &&/|| operand must NOT absorb this into an allow.
      throw new RuleResourceLimitError('firestore access limit exceeded: at most two distinct documents');
    }
    ctx.firestoreAccesses.add(docPath);
  }
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
 * Assemble a {@link PathArgSegment} list into the document path the
 * {@link FirestoreLookup} expects, then validate + strip the required
 * `/databases/<db>/documents/` prefix. Interpolations must resolve to a
 * string or number; anything else (e.g. `request.auth.uid` when auth is
 * null → undefined) throws → deny.
 */
function buildFirestoreDocPath(
  pathExpr: Extract<Expr, { kind: 'path' }>,
  ctx: EvalCtx,
): string {
  // Every interpolation evaluates when an earlier one errors; the first
  // error denies.
  const interpolated = evalOperands(pathExpr.segments.flatMap((seg) => (seg.kind === 'literal' ? [] : [seg.expr])), ctx);
  if (isErr(interpolated)) throw new RuleEvalError(interpolated.message);
  let next = 0;
  const parts = pathExpr.segments.map((seg) => {
    if (seg.kind === 'literal') return seg.value;
    const v = interpolated[next++];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    throw new RuleEvalError(
      `Firestore path interpolation resolved to ${describeType(v)} (expected a string)`,
    );
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
  return docSegments.join('/');
}
