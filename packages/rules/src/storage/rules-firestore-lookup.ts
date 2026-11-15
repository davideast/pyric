import type { Expr } from './rules.js';
import { evalExpr, evalOperand, evalOperands, type EvalCtx } from './rules-evaluator.js';
import {
  RuleEvalError,
  RuleResourceLimitError,
  RuleUnsupportedError,
} from './rules-evaluation-error.js';
import { StorageLatLng } from './rules-latlng.js';
import { StoragePath, interpolationSegments, isPathValue, pathValueSegments } from './rules-path.js';
import { functionNotFoundMessage } from '../simulator/eval-error.js';
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
import { Vector } from '../simulator/wrappers/vector.js';
import { isUnresolvedWriteSentinel } from '../test/case-refusals.js';
import {
  RuleError,
  isRuleError as isErr,
} from './rules-values.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');
const UNESCAPED_MAP_REGISTRY_KEY = Symbol.for('pyric.firestore.unescaped-user-maps');

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUnescapedUserMap(obj: object): boolean {
  if ((obj as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true) return true;
  const store = globalThis as Record<symbol, WeakSet<object> | undefined>;
  const registry = store[UNESCAPED_MAP_REGISTRY_KEY];
  return registry !== undefined && registry.has(obj);
}

function wrapPlainMap(obj: Record<string, unknown>, publicCases: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    Object.defineProperty(out, k, {
      value: wrapFirestoreValue(v, publicCases),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function extractSdkDatabaseId(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.databaseId === 'string' && obj.databaseId.length > 0) {
    return obj.databaseId;
  }
  const firestore = obj._firestore ?? obj.firestore;
  if (typeof firestore === 'object' && firestore !== null) {
    const dbId = (firestore as Record<string, unknown>)._databaseId;
    if (typeof dbId === 'object' && dbId !== null) {
      const database = (dbId as Record<string, unknown>).database;
      if (typeof database === 'string' && database.length > 0) return database;
    }
  }
  return undefined;
}

function wrapNonPlainSdkValue(obj: Record<string, unknown>): unknown | undefined {
  if (
    typeof obj.latitude === 'number' &&
    typeof obj.longitude === 'number' &&
    typeof obj.isEqual === 'function'
  ) {
    return new StorageLatLng(obj.latitude, obj.longitude);
  }
  if (
    typeof obj.toUint8Array === 'function' &&
    typeof obj.toBase64 === 'function' &&
    typeof obj.isEqual === 'function'
  ) {
    const raw = (obj.toUint8Array as () => unknown)();
    if (raw instanceof Uint8Array) return new Bytes(raw);
  }
  if (
    typeof obj.seconds === 'number' &&
    typeof obj.nanoseconds === 'number' &&
    typeof obj.toMillis === 'function'
  ) {
    return new Timestamp(obj.seconds, obj.nanoseconds);
  }
  if (
    typeof obj.path === 'string' &&
    typeof obj.id === 'string' &&
    (obj._firestore !== undefined || obj.firestore !== undefined)
  ) {
    return storagePathFromReferenceString(obj.path, extractSdkDatabaseId(obj));
  }
  if (typeof obj.toArray === 'function' && typeof obj.isEqual === 'function') {
    const raw = (obj.toArray as () => unknown)();
    if (Array.isArray(raw) && raw.every((item): item is number => typeof item === 'number')) {
      return new Vector(raw);
    }
  }
  return undefined;
}

function isWireRevivableObject(obj: Record<string, unknown>): boolean {
  if (typeof obj.__type === 'string') return true;
  if (typeof obj.type === 'string') {
    if (obj.type.startsWith('firestore/') || obj.type.startsWith('pyric/')) return true;
  }
  if (obj.__type__ === '__vector__') return true;
  return typeof obj.id === 'string' && typeof obj.path === 'string';
}

/**
 * Wrap raw Firestore document data values into Storage rules values,
 * preserving RulesValue and SDK scalar instances while keeping plain user
 * maps as maps.
 */
function wrapFirestoreValue(val: unknown, publicCases: boolean): unknown {
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
    let refPath = `/databases/${val.databaseId}/documents`;
    if (val.path.length > 0) {
      refPath = `/databases/${val.databaseId}/documents/${val.path}`;
    }
    return new StoragePath(refPath);
  }
  if (val instanceof RulesValue) {
    return val;
  }
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      return val.map((item) => wrapFirestoreValue(item, publicCases));
    }
    const obj = val as Record<string, unknown>;
    if (!isPlainObject(obj)) {
      const wrappedSdk = wrapNonPlainSdkValue(obj);
      if (wrappedSdk !== undefined) return wrappedSdk;
      return wrapPlainMap(obj, publicCases);
    }
    if (isUnescapedUserMap(obj)) {
      return wrapPlainMap(obj, publicCases);
    }
    if (isUnresolvedWriteSentinel(obj)) {
      throw new RuleUnsupportedError(
        'Stored Firestore documents cannot contain unresolved write FieldValue sentinels.',
      );
    }
    if (publicCases) {
      return wrapPlainMap(obj, true);
    }
    if (obj.__type === 'path') {
      if (Array.isArray(obj.segments)) {
        const bindings: Record<string, string> = {};
        if (typeof obj.bindings === 'object' && obj.bindings !== null && !Array.isArray(obj.bindings)) {
          for (const [k, v] of Object.entries(obj.bindings as Record<string, unknown>)) {
            Object.defineProperty(bindings, k, {
              value: String(v),
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
        }
        return StoragePath.fromSegments(obj.segments.map(String), bindings);
      }
      if (typeof obj.path === 'string') {
        const normalized = obj.path.length > 1 ? obj.path.replace(/\/+$/, '') : obj.path;
        return new StoragePath(normalized);
      }
    }
    if ((obj.__type === 'reference' || obj.__type === 'ref') && typeof obj.path === 'string') {
      const dbId = typeof obj.databaseId === 'string' && obj.databaseId.length > 0 ? obj.databaseId : undefined;
      return storagePathFromReferenceString(obj.path, dbId);
    }
    if (obj.__type === 'latlng') {
      const lat = obj.latitude ?? obj._latitude ?? obj.lat;
      const lng = obj.longitude ?? obj._longitude ?? obj.lng;
      if (typeof lat === 'number' && typeof lng === 'number') {
        return new StorageLatLng(lat, lng);
      }
    }
    if (isWireRevivableObject(obj)) {
      const revived = reviveFirestoreNumbers(obj);
      if (revived instanceof RulesValue) {
        return wrapFirestoreValue(revived, false);
      }
      if (typeof revived === 'object' && revived !== null && isUnescapedUserMap(revived)) {
        return wrapFirestoreValue(revived, false);
      }
    }
    return wrapPlainMap(obj, false);
  }
  return val;
}

function storagePathFromReferenceString(rawPath: string, databaseId: string = '(default)'): StoragePath {
  let trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  const projectsMatch = /^projects\/[^/]+\/(databases(?:\/.*)?)$/.exec(trimmed);
  if (projectsMatch && projectsMatch[1] !== undefined) trimmed = projectsMatch[1];
  if (/^databases\/[^/]+\/documents(?:\/|$)/.test(trimmed)) {
    return new StoragePath(`/${trimmed}`);
  }
  if (trimmed.length > 0) {
    return new StoragePath(`/databases/${databaseId}/documents/${trimmed}`);
  }
  return new StoragePath(`/databases/${databaseId}/documents`);
}

export function evalFirestoreBuiltin(expr: MethodCall, ctx: EvalCtx): unknown {
  // The unit a namespace call costs beyond its argument, charged before the
  // path evaluates (no capture measures it after an erroring path).
  ctx.expressionBudget?.node(expr);
  if (expr.method !== 'get' && expr.method !== 'exists') {
    const args = evalOperands(expr.args, ctx);
    if (isErr(args)) return args;
    return new RuleError(functionNotFoundMessage(expr.method));
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
  return { data: wrapFirestoreValue(fields, ctx.firestoreLookup.publicCases === true) as Record<string, unknown> };
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
