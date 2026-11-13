import type { RequestEvent, SandboxEvent } from 'pyric/sandbox';
import { fieldPathKeySegments } from 'pyric/firestore/internal/update-fields';
import {
  reviveFirestoreNumbers,
  RulesValue,
  type FirestoreMethod,
} from 'pyric/rules/internal';

const DELETE_FIELD_SYM: unique symbol = Symbol('verify:deleteField');
const ABSENT_SYM: unique symbol = Symbol('verify:absent');
const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');

function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isUnescapedCaseMap(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true
  );
}

function copyUnescapedTag<T extends Record<string, unknown>>(source: unknown, target: T): T {
  if (isUnescapedCaseMap(source)) {
    Object.defineProperty(target, UNESCAPED_MAP_TAG, { value: true });
  }
  return target;
}

function isPlainObjectProto(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof RulesValue) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSerializedScalarMarker(value: Record<string, unknown>): boolean {
  if (typeof value.__type === 'string') {
    return (
      value.__type === 'reference' ||
      value.__type === 'timestamp' ||
      value.__type === 'bytes' ||
      value.__type === 'latlng' ||
      value.__type === 'duration' ||
      value.__type === 'path' ||
      value.__type === 'float'
    );
  }
  if (value.__type__ === '__vector__' && Array.isArray(value.value)) return true;
  if (typeof value.type === 'string') {
    return (
      value.type === 'pyric/number/1.0' ||
      value.type.startsWith('firestore/')
    );
  }
  return false;
}

export function unwrapEscapedCaseValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => unwrapEscapedCaseValue(item));
  }
  if (!isPlainObjectProto(value)) return value;
  const alreadyUnescaped = isUnescapedCaseMap(value);
  if (
    !alreadyUnescaped &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'type') &&
    value.type === 'pyric/map/1.0' &&
    isPlainObjectProto(value.fields)
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.fields)) {
      defineOwnProperty(out, k, unwrapEscapedCaseValue(v));
    }
    Object.defineProperty(out, UNESCAPED_MAP_TAG, { value: true });
    return out;
  }
  if (!alreadyUnescaped && isSerializedScalarMarker(value)) {
    return reviveFirestoreNumbers(value);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    defineOwnProperty(out, k, unwrapEscapedCaseValue(v));
  }
  return copyUnescapedTag(value, out);
}

function isPlainFirestoreMap(value: unknown): value is Record<string, unknown> {
  if (!isPlainObjectProto(value)) return false;
  if (isUnescapedCaseMap(value)) return true;
  const obj = value as Record<string, unknown>;
  if (typeof obj.__type === 'string') return false;
  if (typeof obj._methodName === 'string') return false;
  if (obj.__type__ === '__vector__') return false;
  if (
    typeof obj.type === 'string' &&
    (obj.type.startsWith('firestore/') || obj.type.startsWith('pyric/'))
  ) {
    return false;
  }
  return true;
}

export function extractMergeFields(merge: unknown): string[] | undefined {
  if (typeof merge !== 'object' || merge === null || Array.isArray(merge)) return undefined;
  const raw = (merge as { mergeFields?: unknown }).mergeFields;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((item): item is string => typeof item === 'string');
}

function maskHasLiteralDotSegment(mask: readonly unknown[]): boolean {
  return mask.some(
    (entry) =>
      Array.isArray(entry) &&
      entry.some((seg) => typeof seg === 'string' && seg.includes('.')),
  );
}

function containsNonPassthroughSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsNonPassthroughSentinel);
  const obj = value as Record<string, unknown>;
  if (
    !isUnescapedCaseMap(value) &&
    (obj.__type === 'deleteField' ||
      obj.__type === 'increment' ||
      obj.__type === 'arrayUnion' ||
      obj.__type === 'arrayRemove' ||
      typeof obj._methodName === 'string')
  ) {
    return true;
  }
  if (!isPlainFirestoreMap(value)) return false;
  return Object.values(obj).some(containsNonPassthroughSentinel);
}

function containsCollidingOrUnescapedMap(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsCollidingOrUnescapedMap);
  if (isUnescapedCaseMap(value)) return true;
  if (!isPlainObjectProto(value)) return false;
  if (hasCollidingMarkerKeys(value)) return true;
  return Object.values(value).some(containsCollidingOrUnescapedMap);
}

export function needsDeniedCandidateProjection(
  rawData: Record<string, unknown>,
  existing: Record<string, unknown> | null,
  updateMask: unknown,
  mergeFields: string[] | undefined,
): boolean {
  if (mergeFields !== undefined) return true;
  if (Array.isArray(updateMask)) {
    if (maskHasLiteralDotSegment(updateMask)) return true;
    if (containsCollidingOrUnescapedMap(rawData)) return true;
    if (existing !== null && containsCollidingOrUnescapedMap(existing)) return true;
  }
  return containsNonPassthroughSentinel(rawData);
}

export function rebuildUpdateMaskPayload(
  tree: Record<string, unknown>,
  mask: readonly unknown[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawPath of mask) {
    if (!Array.isArray(rawPath) || !rawPath.every((seg): seg is string => typeof seg === 'string')) {
      continue;
    }
    let cursor: unknown = tree;
    for (const seg of rawPath) {
      if (typeof cursor === 'object' && cursor !== null && Object.hasOwn(cursor, seg)) {
        cursor = (cursor as Record<string, unknown>)[seg];
      } else {
        cursor = undefined;
      }
    }
    defineOwnProperty(out, rawPath.join('.'), cursor);
  }
  return out;
}

function readBySegments(
  root: Record<string, unknown> | null,
  segments: readonly (string | number)[],
): unknown {
  if (root === null) return ABSENT_SYM;
  let cursor: unknown = root;
  for (const seg of segments) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cursor) || seg < 0 || seg >= cursor.length) return ABSENT_SYM;
      cursor = cursor[seg];
      continue;
    }
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return ABSENT_SYM;
    if (!Object.hasOwn(cursor, seg)) return ABSENT_SYM;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function numericValueOf(val: unknown): number | undefined {
  if (typeof val === 'number') return val;
  if (val instanceof RulesValue && val.typeName === 'float') {
    const inner = (val as { value?: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  if (typeof val === 'object' && val !== null && (val as { __type?: unknown }).__type === 'float') {
    const inner = (val as { value?: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  return undefined;
}

function deepFirestoreEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return (Number.isNaN(a) && Number.isNaN(b)) || a === b;
  }
  if (a === b) return true;
  if (a instanceof RulesValue && b instanceof RulesValue) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, idx) => deepFirestoreEqual(item, b[idx]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b) &&
    !(a instanceof RulesValue) &&
    !(b instanceof RulesValue)
  ) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    return keysA.every((k) => Object.hasOwn(recB, k) && deepFirestoreEqual(recA[k], recB[k]));
  }
  return false;
}

function resolveFieldTree(
  value: unknown,
  priorRoot: Record<string, unknown> | null,
  fieldSegments: readonly (string | number)[],
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .map((item, idx) => resolveFieldTree(item, priorRoot, [...fieldSegments, idx]))
      .filter((item) => item !== DELETE_FIELD_SYM);
  }
  const obj = value as Record<string, unknown>;
  const isUnescaped = isUnescapedCaseMap(value);
  if (!isUnescaped) {
    const methodName = typeof obj._methodName === 'string' ? obj._methodName : undefined;
    if (
      obj.__type === 'deleteField' ||
      methodName === 'deleteField' ||
      methodName === 'FieldValue.delete' ||
      methodName === 'FieldValue.deleteField'
    ) {
      return DELETE_FIELD_SYM;
    }
    if (
      obj.__type === 'serverTimestamp' ||
      methodName === 'serverTimestamp' ||
      methodName === 'FieldValue.serverTimestamp'
    ) {
      return { __type: 'serverTimestamp' };
    }
    if (
      (obj.__type === 'increment' && typeof obj.value === 'number') ||
      ((methodName === 'increment' || methodName === 'FieldValue.increment') &&
        typeof obj._operand === 'number')
    ) {
      const delta = typeof obj.value === 'number' ? obj.value : (obj._operand as number);
      const priorVal = readBySegments(priorRoot, fieldSegments);
      const base = numericValueOf(priorVal) ?? 0;
      return base + delta;
    }
    if (
      (obj.__type === 'arrayUnion' && Array.isArray(obj.values)) ||
      ((methodName === 'arrayUnion' || methodName === 'FieldValue.arrayUnion') &&
        Array.isArray(obj._elements))
    ) {
      const sourceItems = Array.isArray(obj.values) ? obj.values : (obj._elements as unknown[]);
      const rawItems = sourceItems.map((item) => resolveFieldTree(item, priorRoot, fieldSegments));
      const priorVal = readBySegments(priorRoot, fieldSegments);
      const base = Array.isArray(priorVal) ? priorVal.slice() : [];
      for (const item of rawItems) {
        if (item === DELETE_FIELD_SYM) continue;
        if (!base.some((existing) => deepFirestoreEqual(existing, item))) {
          base.push(item);
        }
      }
      return base;
    }
    if (
      (obj.__type === 'arrayRemove' && Array.isArray(obj.values)) ||
      ((methodName === 'arrayRemove' || methodName === 'FieldValue.arrayRemove') &&
        Array.isArray(obj._elements))
    ) {
      const sourceItems = Array.isArray(obj.values) ? obj.values : (obj._elements as unknown[]);
      const rawItems = sourceItems.map((item) => resolveFieldTree(item, priorRoot, fieldSegments));
      const priorVal = readBySegments(priorRoot, fieldSegments);
      if (!Array.isArray(priorVal)) return [];
      return priorVal.filter(
        (existing) => !rawItems.some((item) => deepFirestoreEqual(existing, item)),
      );
    }
  }
  if (!isPlainFirestoreMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    defineOwnProperty(out, k, resolveFieldTree(v, priorRoot, [...fieldSegments, k]));
  }
  return copyUnescapedTag(value, out);
}

function stripDeleteSymbols(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== DELETE_FIELD_SYM).map(stripDeleteSymbols);
  }
  if (!isPlainFirestoreMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === DELETE_FIELD_SYM) continue;
    defineOwnProperty(out, k, stripDeleteSymbols(v));
  }
  return copyUnescapedTag(value, out);
}

function cloneFieldValue(value: unknown): unknown {
  if (isPlainFirestoreMap(value)) return clonePlainMap(value);
  if (Array.isArray(value)) return value.map(cloneFieldValue);
  return value;
}

export function clonePlainMap(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    defineOwnProperty(out, k, cloneFieldValue(v));
  }
  return copyUnescapedTag(src, out);
}

function hasCollidingMarkerKeys(map: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(map, '__type') ||
    Object.hasOwn(map, 'type') ||
    Object.hasOwn(map, '__type__') ||
    Object.hasOwn(map, '_methodName') ||
    Object.hasOwn(map, 'typeName') ||
    (Object.hasOwn(map, 'id') && Object.hasOwn(map, 'path'))
  );
}

function applyPathLeaf(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  if (segments.length === 0) return;
  const ancestors: Record<string, unknown>[] = [root];
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const existing = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (!isPlainFirestoreMap(existing)) {
      const fresh: Record<string, unknown> = {};
      defineOwnProperty(cursor, seg, fresh);
      cursor = fresh;
    } else {
      cursor = existing;
    }
    ancestors.push(cursor);
  }
  const leaf = segments[segments.length - 1]!;
  if (value === DELETE_FIELD_SYM) {
    if (Object.hasOwn(cursor, leaf)) delete cursor[leaf];
  } else {
    defineOwnProperty(cursor, leaf, stripDeleteSymbols(value));
  }
  for (const ancestor of ancestors) {
    if (hasCollidingMarkerKeys(ancestor)) {
      Object.defineProperty(ancestor, UNESCAPED_MAP_TAG, { value: true });
    }
  }
}

function collectMergeLeaves(
  data: Record<string, unknown>,
  prefix: readonly string[],
  out: Array<{ segments: readonly string[]; value: unknown }>,
): void {
  const keys = Object.keys(data);
  if (keys.length === 0 && prefix.length > 0) {
    out.push({ segments: prefix, value: {} });
    return;
  }
  for (const key of keys) {
    const value = data[key];
    const segments = [...prefix, key];
    if (isPlainFirestoreMap(value)) {
      collectMergeLeaves(value, segments, out);
    } else {
      out.push({ segments, value });
    }
  }
}

export function projectDeniedWriteCandidate(
  rawData: Record<string, unknown>,
  prior: Record<string, unknown> | null,
  method: FirestoreMethod,
  rawEventMethod: RequestEvent['method'],
  reqMerge: unknown,
  mergeFields: string[] | undefined,
  updateMask: unknown,
): Record<string, unknown> {
  if (Array.isArray(updateMask)) {
    const out = clonePlainMap(prior ?? {});
    for (const rawPath of updateMask) {
      if (
        !Array.isArray(rawPath) ||
        rawPath.length === 0 ||
        !rawPath.every((seg): seg is string => typeof seg === 'string')
      ) {
        continue;
      }
      const rawLeaf = readBySegments(rawData, rawPath);
      if (rawLeaf === ABSENT_SYM) continue;
      const resolvedLeaf = resolveFieldTree(rawLeaf, prior, rawPath);
      applyPathLeaf(out, rawPath, resolvedLeaf);
    }
    return out;
  }

  if (mergeFields !== undefined) {
    const out = clonePlainMap(prior ?? {});
    for (const field of mergeFields) {
      const segments = fieldPathKeySegments(field);
      const rawLeaf = readBySegments(rawData, segments);
      if (rawLeaf === ABSENT_SYM) continue;
      const resolvedLeaf = resolveFieldTree(rawLeaf, prior, segments);
      applyPathLeaf(out, segments, resolvedLeaf);
    }
    return out;
  }

  const isMergeTrue =
    reqMerge === true ||
    (method === 'update' && rawEventMethod === 'update' && reqMerge === undefined);
  if (isMergeTrue) {
    const out = clonePlainMap(prior ?? {});
    const resolvedTree = resolveFieldTree(rawData, prior, []) as Record<string, unknown>;
    const leaves: Array<{ segments: readonly string[]; value: unknown }> = [];
    collectMergeLeaves(resolvedTree, [], leaves);
    for (const leaf of leaves) {
      applyPathLeaf(out, leaf.segments, leaf.value);
    }
    return out;
  }

  const resolved = resolveFieldTree(rawData, prior, []);
  return stripDeleteSymbols(resolved) as Record<string, unknown>;
}

function resolveIntraBatchPrior(
  proj: ReadonlyMap<string, Record<string, unknown> | null>,
  path: string,
  method: FirestoreMethod,
  preBatchExisting: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (proj.has(path)) {
    return proj.get(path) ?? null;
  }
  if (method === 'create') {
    return null;
  }
  return preBatchExisting;
}

function resolveEffectiveBatchMethod(
  method: FirestoreMethod,
  intraPrior: Record<string, unknown> | null,
): FirestoreMethod {
  if (method !== 'delete') return method;
  if (intraPrior !== null) return 'update';
  return 'create';
}

export function buildCommittedGroupFinalStates(
  events: readonly SandboxEvent[],
): Map<string, Map<string, Record<string, unknown> | null>> {
  const byGroup = new Map<string, Map<string, Record<string, unknown> | null>>();
  for (const event of events) {
    if (event.kind !== 'write' || typeof event.groupId !== 'string') continue;
    let groupState = byGroup.get(event.groupId);
    if (!groupState) {
      groupState = new Map();
      byGroup.set(event.groupId, groupState);
    }
    if (event.method === 'delete' || event.nextState === null) {
      groupState.set(event.path, null);
    } else {
      groupState.set(
        event.path,
        unwrapEscapedCaseValue(event.nextState) as Record<string, unknown>,
      );
    }
  }
  return byGroup;
}

export function buildUncommittedGroupProjections(
  events: readonly SandboxEvent[],
  committedGroupIds: ReadonlySet<string>,
  classifyRequest: (event: SandboxEvent) => {
    request: RequestEvent;
    method: FirestoreMethod;
  } | null,
): Map<string, Map<string, Record<string, unknown> | null>> {
  const byGroup = new Map<string, Map<string, Record<string, unknown> | null>>();
  for (const rawEvent of events) {
    const classified = classifyRequest(rawEvent);
    if (!classified) continue;
    const { request: event, method } = classified;
    if (method !== 'create' && method !== 'update' && method !== 'delete') continue;
    const groupId = (event as { groupId?: unknown }).groupId;
    if (typeof groupId !== 'string' || committedGroupIds.has(groupId)) continue;

    let proj = byGroup.get(groupId);
    if (!proj) {
      proj = new Map();
      byGroup.set(groupId, proj);
    }

    let preBatchExisting: Record<string, unknown> | null = null;
    if (event.resourceBefore?.exists && event.resourceBefore.data !== null) {
      preBatchExisting = unwrapEscapedCaseValue(event.resourceBefore.data) as Record<string, unknown>;
    }
    const intraPrior = resolveIntraBatchPrior(proj, event.path, method, preBatchExisting);

    const sourceRawData = event.request?.resourceData;
    if (event.method === 'delete' && sourceRawData === undefined) {
      proj.set(event.path, null);
      continue;
    }

    let rawData: Record<string, unknown> | undefined;
    if (typeof sourceRawData === 'object' && sourceRawData !== null && !Array.isArray(sourceRawData)) {
      rawData = unwrapEscapedCaseValue(sourceRawData) as Record<string, unknown>;
    }
    if (!rawData) {
      if (method === 'delete') proj.set(event.path, null);
      continue;
    }

    const reqObj = event.request as { updateMask?: unknown; merge?: unknown } | undefined;
    const updateMask = reqObj?.updateMask;
    const reqMerge = reqObj?.merge;
    const mergeFields = extractMergeFields(reqMerge);
    const effectiveMethod = resolveEffectiveBatchMethod(method, intraPrior);
    const projected = projectDeniedWriteCandidate(
      rawData,
      intraPrior,
      effectiveMethod,
      event.method,
      reqMerge,
      mergeFields,
      updateMask,
    );
    proj.set(event.path, projected);
  }
  return byGroup;
}
