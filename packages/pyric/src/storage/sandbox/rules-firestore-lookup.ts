import type { Expr } from './rules.js';
import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import {
  RuleEvalError,
  RuleResourceLimitError,
  RuleUnsupportedError,
} from './rules-evaluation-error.js';
import { StorageLatLng } from './rules-latlng.js';
import { StoragePath } from './rules-path.js';
import {
  RuleError,
  describeRulesType as describeType,
  isRuleError as isErr,
} from './rules-values.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * Wrap raw Firestore document data values into Storage rules values
 * (wrapping GeoPoint as latlng and DocumentReference/Path as path).
 */
function wrapFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      return val.map(wrapFirestoreValue);
    }
    const obj = val as Record<string, unknown>;
    const lat = obj.latitude ?? obj._latitude;
    const lng = obj.longitude ?? obj._longitude;
    if (typeof lat === 'number' && typeof lng === 'number') {
      return new StorageLatLng(lat, lng);
    }
    if (typeof obj.path === 'string' && obj.path.startsWith('/')) {
      return new StoragePath(obj.path);
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
    // Wrong call shape: production rejects at compile; never absorbed.
    throw new RuleUnsupportedError(`firestore.${expr.method}() expects a single path argument`);
  }
  const arg = expr.args[0];
  let docPath: string;
  if (arg.kind === 'path') {
    docPath = buildFirestoreDocPath(arg, ctx);
  } else {
    const val = evalExpr(arg, ctx);
    if (isErr(val)) return val;
    if (typeof val === 'string' || val instanceof StoragePath) {
      const pathString = val instanceof StoragePath ? val.path : val;
      const segments = pathString.split('/').filter(Boolean).map((value) => ({ kind: 'literal' as const, value }));
      docPath = buildFirestoreDocPath({ kind: 'path', segments }, ctx);
    } else {
      throw new RuleUnsupportedError(
        `firestore.${expr.method}() requires a /databases/.../documents/... path literal`,
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
  const parts = pathExpr.segments.map((seg) => {
    if (seg.kind === 'literal') return seg.value;
    const v = evalExpr(seg.expr, ctx);
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
