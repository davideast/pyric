/**
 * Value rehydration, call-map escaping, and collection-group rule projection
 * for local Firestore observation (`observe-local-firestore.ts`).
 */
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
  Bytes,
  indexRulesetScopes,
  LatLng,
  Reference,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
  Timestamp,
  topLevelMatches,
  Vector,
  type AllowRule,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
} from 'pyric/rules/internal';
import {
  hasCollidingFirestoreMarkerShape,
  stampUnescapedUserMap,
  type ObservedMethod,
} from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { ObservedFirestoreDocLookup } from '../../observed-session/coverage.js';
import type { ObservedSessionDataStore } from '../../observed-session/store.js';
import { isPlainRecord } from './observe-local-evaluation.js';

const FORBIDDEN_DOC_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function defineOwnDocField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function groupBindings(block: MatchBlock, collectionId: string): Set<string> | null {
  const [first, second, third, ...rest] = block.path.segments;
  if (first?.type !== 'recursive') return null;
  if (!second) return new Set([first.name]);
  if (
    second.type === 'literal' &&
    second.value === collectionId &&
    third?.type === 'wildcard' &&
    rest.length === 0
  ) {
    return new Set([first.name, third.name]);
  }
  return null;
}

function projectPathInvariantCondition(
  expr: Expression,
  bound: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
): { condition: Expression; requiredFunctionDefs: ReadonlySet<FunctionDef> } | null {
  const analysis = analyzeListRulePathInvariance(expr, bound, functions, ambiguousNames);
  if (analysis.pathInvariant) {
    return { condition: expr, requiredFunctionDefs: analysis.requiredFunctionDefs };
  }
  if (expr.type === 'unaryOp' && expr.op === '!') {
    const inner = expr.operand;
    if (inner.type === 'binaryOp' && inner.op === '&&') {
      return projectPathInvariantCondition(
        {
          type: 'binaryOp',
          op: '||',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    if (inner.type === 'binaryOp' && inner.op === '||') {
      return projectPathInvariantCondition(
        {
          type: 'binaryOp',
          op: '&&',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    if (inner.type === 'unaryOp' && inner.op === '!') {
      const sub = projectPathInvariantCondition(inner.operand, bound, functions, ambiguousNames);
      if (!sub) return null;
      return {
        condition: { type: 'unaryOp', op: '!', operand: { type: 'unaryOp', op: '!', operand: sub.condition } },
        requiredFunctionDefs: sub.requiredFunctionDefs,
      };
    }
  }
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    const left = projectPathInvariantCondition(expr.left, bound, functions, ambiguousNames);
    const right = projectPathInvariantCondition(expr.right, bound, functions, ambiguousNames);
    if (left && right) {
      return {
        condition: { ...expr, left: left.condition, right: right.condition },
        requiredFunctionDefs: new Set([...left.requiredFunctionDefs, ...right.requiredFunctionDefs]),
      };
    }
    if (expr.op === '||') {
      return left ?? right;
    }
  }
  return null;
}

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  outerFunctions: readonly FunctionDef[],
  requiredFunctionDefs: Set<FunctionDef>,
): MatchBlock | null {
  const bound = groupBindings(block, collectionId);
  if (!bound) return null;

  const functionScope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const blockRequiredDefs = new Set<FunctionDef>();
  const allows: AllowRule[] = [];

  for (const rule of block.allows) {
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      continue;
    }
    const projected = projectPathInvariantCondition(
      rule.condition,
      bound,
      functionScope.functions,
      functionScope.ambiguousNames,
    );
    if (!projected) continue;
    for (const fnDef of projected.requiredFunctionDefs) {
      if (block.functions.includes(fnDef)) {
        blockRequiredDefs.add(fnDef);
      } else {
        requiredFunctionDefs.add(fnDef);
      }
    }
    let nextRule = rule;
    if (projected.condition !== rule.condition) {
      nextRule = { ...rule, condition: projected.condition };
    }
    allows.push(nextRule);
  }
  if (allows.length === 0) return null;

  return {
    ...block,
    functions: block.functions.filter((fn) => blockRequiredDefs.has(fn)),
    allows,
    children: [],
  };
}

export function projectCollectionGroupRules(ast: FirestoreRules, collectionId: string): FirestoreRules | null {
  if (!rootGovernsEveryDocument(ast)) return null;
  indexRulesetScopes(ast);

  const serviceFunctions = [...(ast.functions ?? []), ...(ast.service.functions ?? [])];
  const requiredFunctionDefs = new Set<FunctionDef>();
  const retainRequired = (functions: readonly FunctionDef[] | undefined): FunctionDef[] | undefined =>
    functions?.filter((fn) => requiredFunctionDefs.has(fn));

  const projectedRoots: MatchBlock[] = [];
  for (const rootBlock of topLevelMatches(ast.service)) {
    if (!rootBlockGovernsEveryDocument(rootBlock, ast.version)) continue;
    const outerFunctions = [...serviceFunctions, ...rootBlock.functions];
    const children: MatchBlock[] = [];
    for (const block of rootBlock.children) {
      const projected = projectGroupBlock(block, collectionId, outerFunctions, requiredFunctionDefs);
      if (projected) children.push(projected);
    }
    if (children.length === 0) continue;
    projectedRoots.push({
      ...rootBlock,
      functions: retainRequired(rootBlock.functions) ?? [],
      children,
    });
  }
  if (projectedRoots.length === 0) return null;

  return {
    ...ast,
    functions: retainRequired(ast.functions),
    service: {
      ...ast.service,
      functions: retainRequired(ast.service.functions),
      match: projectedRoots[0]!,
      matches: projectedRoots,
    },
  };
}

function decodeStandardBase64(encoded: string): Uint8Array {
  const bin = atob(encoded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isEscapedMapEnvelope(
  value: Record<string, unknown>,
): value is { type: 'pyric/map/1.0'; fields: Record<string, unknown> } {
  return (
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'type') &&
    value.type === 'pyric/map/1.0' &&
    isPlainRecord(value.fields)
  );
}

function prepareCallEntriesForRules(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    defineOwnDocField(out, k, prepareCallValueForRules(v));
  }
  return out;
}

function prepareCallValueForRules(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => prepareCallValueForRules(item));
  }
  if (!isPlainRecord(value)) return value;
  if (isEscapedMapEnvelope(value)) {
    return stampUnescapedUserMap(prepareCallEntriesForRules(value.fields));
  }
  const out = prepareCallEntriesForRules(value);
  if (hasCollidingFirestoreMarkerShape(out)) {
    stampUnescapedUserMap(out);
  }
  return out;
}

/**
 * Prepare a plain JSON map from `ObservedCall.writeData` or `ObservedCall.document`
 * for rules simulation so user maps with sentinel/wrapper marker keys stay maps.
 */
export function prepareCallMapForRules(data: Record<string, unknown>): Record<string, unknown> {
  if (isEscapedMapEnvelope(data)) {
    return stampUnescapedUserMap(prepareCallEntriesForRules(data.fields));
  }
  const out = prepareCallEntriesForRules(data);
  if (hasCollidingFirestoreMarkerShape(out)) {
    stampUnescapedUserMap(out);
  }
  return out;
}

function rehydrateSessionEntriesForRules(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (FORBIDDEN_DOC_KEYS.has(k)) continue;
    defineOwnDocField(out, k, rehydrateSessionValueForRules(v));
  }
  if (hasCollidingFirestoreMarkerShape(out)) {
    stampUnescapedUserMap(out);
  }
  return out;
}

function rehydrateSessionValueForRules(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => rehydrateSessionValueForRules(item));
  }
  if (!isPlainRecord(value)) return value;
  const keys = Object.keys(value);
  if (isEscapedMapEnvelope(value)) {
    return stampUnescapedUserMap(rehydrateSessionEntriesForRules(value.fields));
  }
  if (keys.length === 2 && value.type === 'pyric/number/1.0') {
    if (value.value === 'NaN') return Number.NaN;
    if (value.value === 'Infinity') return Number.POSITIVE_INFINITY;
    if (value.value === '-Infinity') return Number.NEGATIVE_INFINITY;
    if (value.value === '-0') return -0;
  }
  if (
    (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/timestamp/1.0')) &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  ) {
    try {
      return new Timestamp(Math.trunc(value.seconds), Math.trunc(value.nanoseconds));
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/geoPoint/1.0')) &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number'
  ) {
    try {
      return new LatLng(value.latitude, value.longitude);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (keys.length === 2 && value.type === 'firestore/bytes/1.0' && typeof value.bytes === 'string') {
    try {
      return new Bytes(decodeStandardBase64(value.bytes));
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    keys.length === 2 &&
    value.__type__ === '__vector__' &&
    Array.isArray(value.value) &&
    value.value.every((n) => typeof n === 'number')
  ) {
    try {
      return new Vector(value.value as number[]);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    keys.length === 2 &&
    value.type === 'firestore/vectorValue/1.0' &&
    Array.isArray(value.vectorValues) &&
    value.vectorValues.every((n) => typeof n === 'number')
  ) {
    try {
      return new Vector(value.vectorValues as number[]);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    ((keys.length === 3 || (keys.length === 4 && typeof value.databaseId === 'string')) &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      typeof value.id === 'string') ||
    ((keys.length === 2 || (keys.length === 3 && typeof value.databaseId === 'string')) &&
      value.__type === 'reference' &&
      typeof value.path === 'string')
  ) {
    try {
      const rawPath = value.path as string;
      let normalizedPath = rawPath;
      if (rawPath.startsWith('/')) {
        normalizedPath = rawPath.slice(1);
      }
      let databaseId: string | undefined;
      if (typeof value.databaseId === 'string') {
        databaseId = value.databaseId;
      }
      return new Reference(normalizedPath, databaseId);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  return rehydrateSessionEntriesForRules(value);
}

export function rehydrateSessionDocForRules(data: Record<string, unknown>): Record<string, unknown> {
  if (isEscapedMapEnvelope(data)) {
    return stampUnescapedUserMap(rehydrateSessionEntriesForRules(data.fields));
  }
  return rehydrateSessionEntriesForRules(data);
}

export interface ResolvedTargetDoc {
  readonly status: ObservedFirestoreDocLookup['status'];
  readonly data?: Record<string, unknown>;
}

export function resolveTargetDoc(
  call: ObservedCall,
  path: string,
  method: ObservedMethod,
  observedSession: ObservedSessionDataStore | undefined,
): ResolvedTargetDoc {
  if (call.document !== undefined) {
    return { status: 'complete', data: prepareCallMapForRules(call.document) };
  }
  if (method === 'list' || observedSession === undefined) {
    return { status: 'unobserved' };
  }
  const resolved = observedSession.getFirestoreDoc(path);
  if (resolved.status === 'complete') {
    return { status: 'complete', data: rehydrateSessionDocForRules(resolved.data) };
  }
  return resolved;
}
