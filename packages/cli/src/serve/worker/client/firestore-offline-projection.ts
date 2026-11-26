/**
 * Pure encoded-JSON document projection for offline Firestore client writes on
 * the worker/hosted client plane (leaf-safe: no sandbox rules engine imports).
 */
import { firestoreValuesEqual } from 'pyric/firestore/internal';
import { fieldPathKeySegments } from 'pyric/firestore/internal/update-fields';
import { decodeDocValue } from 'pyric/firestore/internal/value-codec';
import {
  DOC_VALUE_ENCODING,
  type SerializedDocData,
  type TargetDescriptor,
  type UpdateFieldDescriptor,
} from '../protocol.js';
import {
  OFFLINE_REF_DECODER,
  filterWorkerOfflineQueryDocs,
} from './firestore-offline-query-filter.js';
import type { RawDocResult, RawQueryResult } from './snapshots.js';

export type WorkerOfflineMutation =
  | {
      readonly kind: 'set';
      readonly path: string;
      readonly encodedData: unknown;
      readonly options?: { readonly merge?: boolean; readonly mergeFields?: readonly string[] };
    }
  | { readonly kind: 'update'; readonly path: string; readonly fields: readonly UpdateFieldDescriptor[] }
  | { readonly kind: 'delete'; readonly path: string };

const DELETE_SENTINEL: unique symbol = Symbol('worker-offline-delete');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSentinel(value: unknown, kind: string): boolean {
  return isRecord(value) && value.__sentinel === kind;
}

function isEscapedMap(value: Record<string, unknown>): value is { type: 'pyric/map/1.0'; fields: Record<string, unknown> } {
  return value.type === 'pyric/map/1.0' && isRecord(value.fields);
}

function isEncodedTimestamp(value: Record<string, unknown>): boolean {
  if (
    value.__type === 'timestamp'
    && Object.keys(value).length === 3
    && Object.hasOwn(value, 'seconds')
    && Object.hasOwn(value, 'nanos')
  ) {
    return true;
  }
  return (
    value.type === 'firestore/timestamp/1.0'
    && Object.keys(value).length === 3
    && Object.hasOwn(value, 'seconds')
    && Object.hasOwn(value, 'nanoseconds')
  );
}

function truncateEncodedTimestamp(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (
    value.__type === 'timestamp'
    && Object.keys(value).length === 3
    && Object.hasOwn(value, 'seconds')
    && Object.hasOwn(value, 'nanos')
    && typeof value.nanos === 'number'
  ) {
    return {
      __type: 'timestamp',
      seconds: value.seconds,
      nanos: Math.floor(value.nanos / 1_000) * 1_000,
    };
  }
  if (
    value.type === 'firestore/timestamp/1.0'
    && Object.keys(value).length === 3
    && Object.hasOwn(value, 'seconds')
    && Object.hasOwn(value, 'nanoseconds')
    && typeof value.nanoseconds === 'number'
  ) {
    return {
      type: 'firestore/timestamp/1.0',
      seconds: value.seconds,
      nanoseconds: Math.floor(value.nanoseconds / 1_000) * 1_000,
    };
  }
  return undefined;
}

function isEncodedScalar(value: Record<string, unknown>): boolean {
  if (value.__type__ === '__vector__' && Array.isArray(value.value)) return true;
  if (typeof value.__type === 'string') {
    if (value.__type === 'timestamp') return isEncodedTimestamp(value);
    if (
      value.__type === 'bytes'
      || value.__type === 'latlng'
      || value.__type === 'duration'
      || value.__type === 'reference'
      || value.__type === 'path'
      || value.__type === 'number'
      || value.__type === 'int64'
    ) {
      return true;
    }
  }
  if (typeof value.type === 'string') {
    if (value.type === 'firestore/timestamp/1.0') return isEncodedTimestamp(value);
    if (
      value.type === 'firestore/bytes/1.0'
      || value.type === 'firestore/geoPoint/1.0'
      || value.type === 'firestore/vectorValue/1.0'
    ) {
      return true;
    }
  }
  return false;
}

function unwrapEncodedMap(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isEscapedMap(value)) return value.fields;
  if (isEncodedScalar(value)) return undefined;
  return value;
}

function defineOwnField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyOwnFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    defineOwnField(out, k, v);
  }
  return out;
}

function wrapEncodedMap(fields: Record<string, unknown>): Record<string, unknown> {
  const hasMarkerField = Object.hasOwn(fields, 'type')
    || Object.hasOwn(fields, '__type')
    || Object.hasOwn(fields, '__type__')
    || Object.hasOwn(fields, '_methodName')
    || Object.hasOwn(fields, 'typeName')
    || (Object.hasOwn(fields, 'id') && Object.hasOwn(fields, 'path'));
  if (hasMarkerField) return { type: 'pyric/map/1.0', fields };
  return fields;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const INT64_DECIMAL_RE = /^-?\d+$/;

function isSafeIntNumber(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0);
}

function decodeEncodedNumeric(value: unknown): number | bigint | undefined {
  if (typeof value === 'number') return value;
  if (isRecord(value) && value.__type === 'number') {
    if (value.value === 'NaN') return Number.NaN;
    if (value.value === 'Infinity') return Infinity;
    if (value.value === '-Infinity') return -Infinity;
    if (value.value === '-0') return -0;
  }
  if (isRecord(value) && value.__type === 'int64' && typeof value.value === 'string' && INT64_DECIMAL_RE.test(value.value)) {
    const parsed = BigInt(value.value);
    if (parsed >= INT64_MIN && parsed <= INT64_MAX) return parsed;
  }
  return undefined;
}

function encodeNumericResult(value: number | bigint): unknown {
  if (typeof value === 'bigint') {
    let clamped = value;
    if (clamped > INT64_MAX) clamped = INT64_MAX;
    if (clamped < INT64_MIN) clamped = INT64_MIN;
    if (clamped >= MIN_SAFE_BIGINT && clamped <= MAX_SAFE_BIGINT) {
      return Number(clamped);
    }
    return { __type: 'int64', value: clamped.toString() };
  }
  if (Number.isNaN(value)) return { __type: 'number', value: 'NaN' };
  if (value === Infinity) return { __type: 'number', value: 'Infinity' };
  if (value === -Infinity) return { __type: 'number', value: '-Infinity' };
  if (Object.is(value, -0)) return { __type: 'number', value: '-0' };
  return value;
}

function applyOfflineIncrement(prior: unknown, encodedDelta: unknown): unknown {
  const delta = decodeEncodedNumeric(encodedDelta);
  const deltaNum = typeof delta === 'bigint' ? Number(delta) : (delta ?? 0);
  const prev = decodeEncodedNumeric(prior);
  if (prev === undefined) return encodeNumericResult(deltaNum);
  if (typeof prev === 'bigint') {
    if (isSafeIntNumber(deltaNum)) return encodeNumericResult(prev + BigInt(deltaNum));
    return encodeNumericResult(Number(prev) + deltaNum);
  }
  if (isSafeIntNumber(prev) && isSafeIntNumber(deltaNum)) {
    return encodeNumericResult(BigInt(prev) + BigInt(deltaNum));
  }
  return encodeNumericResult(prev + deltaNum);
}

const TWO_POW_63 = 9223372036854775808;

function compareOfflineOperandToPrior(operand: number, prev: number | bigint): number {
  if (typeof prev === 'number') {
    if (operand < prev) return -1;
    if (operand > prev) return 1;
    return 0;
  }
  if (operand === Number.NEGATIVE_INFINITY || operand < -TWO_POW_63) return -1;
  if (operand === Number.POSITIVE_INFINITY || operand >= TWO_POW_63) return 1;
  const truncated = Math.trunc(operand);
  const truncBig = BigInt(truncated);
  if (truncBig < prev) return -1;
  if (truncBig > prev) return 1;
  if (operand < truncated) return -1;
  if (operand > truncated) return 1;
  return 0;
}

function applyOfflineMaximum(prior: unknown, encodedOperand: unknown): unknown {
  const decoded = decodeEncodedNumeric(encodedOperand);
  const operand = typeof decoded === 'bigint' ? Number(decoded) : (decoded ?? 0);
  const prev = decodeEncodedNumeric(prior);
  if (prev === undefined) return encodeNumericResult(operand);
  if (Number.isNaN(operand)) return encodeNumericResult(Number.NaN);
  if (typeof prev === 'number' && Number.isNaN(prev)) return encodeNumericResult(Number.NaN);
  if (compareOfflineOperandToPrior(operand, prev) > 0) {
    return encodeNumericResult(operand);
  }
  return prior;
}

function applyOfflineMinimum(prior: unknown, encodedOperand: unknown): unknown {
  const decoded = decodeEncodedNumeric(encodedOperand);
  const operand = typeof decoded === 'bigint' ? Number(decoded) : (decoded ?? 0);
  const prev = decodeEncodedNumeric(prior);
  if (prev === undefined) return encodeNumericResult(operand);
  if (Number.isNaN(operand)) return encodeNumericResult(Number.NaN);
  if (typeof prev === 'number' && Number.isNaN(prev)) return encodeNumericResult(Number.NaN);
  if (compareOfflineOperandToPrior(operand, prev) < 0) {
    return encodeNumericResult(operand);
  }
  return prior;
}

function lastSegment(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

export function targetMatchesPath(target: TargetDescriptor, path: string): boolean {
  if (target.__ref === 'doc') return target.path === path;
  if (target.__ref === 'collection') {
    const prefix = `${target.path}/`;
    return path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
  }
  if (target.__ref === 'group') {
    const parts = path.split('/');
    return parts.length % 2 === 0 && parts[parts.length - 2] === target.collectionId;
  }
  return targetMatchesPath(target.source, path);
}

function readEncodedAt(root: Record<string, unknown> | null, segments: readonly string[]): { found: boolean; value: unknown } {
  if (root === null) return { found: false, value: null };
  let cur: unknown = root;
  for (const seg of segments) {
    const fields = unwrapEncodedMap(cur);
    if (fields === undefined || !Object.hasOwn(fields, seg)) return { found: false, value: null };
    cur = fields[seg];
  }
  if (cur === undefined) return { found: false, value: null };
  return { found: true, value: cur };
}

function stripDeleteSentinels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDeleteSentinels);
  const fields = unwrapEncodedMap(value);
  if (fields === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === DELETE_SENTINEL || isSentinel(v, 'deleteField')) continue;
    defineOwnField(out, k, stripDeleteSentinels(v));
  }
  return wrapEncodedMap(out);
}

function setEncodedField(root: Record<string, unknown>, segments: readonly string[], value: unknown): Record<string, unknown> {
  const head = segments[0];
  if (head === undefined) return root;
  const fields = unwrapEncodedMap(root) ?? {};
  const out = copyOwnFields(fields);
  if (segments.length === 1) {
    if (value === DELETE_SENTINEL || isSentinel(value, 'deleteField') || value === undefined) {
      delete out[head];
    } else {
      defineOwnField(out, head, stripDeleteSentinels(value));
    }
    return wrapEncodedMap(out);
  }
  let nextChild: Record<string, unknown> = {};
  if (Object.hasOwn(out, head)) {
    const existingFields = unwrapEncodedMap(out[head]);
    if (existingFields !== undefined) nextChild = out[head] as Record<string, unknown>;
  }
  defineOwnField(out, head, setEncodedField(nextChild, segments.slice(1), value));
  return wrapEncodedMap(out);
}

function mergeEncodedMaps(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const baseFields = unwrapEncodedMap(base) ?? {};
  const incomingFields = unwrapEncodedMap(incoming) ?? {};
  const out = copyOwnFields(baseFields);
  for (const [k, v] of Object.entries(incomingFields)) {
    if (v === DELETE_SENTINEL || isSentinel(v, 'deleteField')) {
      delete out[k];
      continue;
    }
    const incomingChildFields = unwrapEncodedMap(v);
    if (incomingChildFields !== undefined) {
      if (Object.keys(incomingChildFields).length === 0) {
        defineOwnField(out, k, {});
        continue;
      }
      const existing = Object.hasOwn(out, k) ? out[k] : undefined;
      if (existing !== undefined && unwrapEncodedMap(existing) !== undefined) {
        defineOwnField(out, k, mergeEncodedMaps(existing as Record<string, unknown>, v as Record<string, unknown>));
      } else {
        defineOwnField(out, k, stripDeleteSentinels(v));
      }
      continue;
    }
    defineOwnField(out, k, v);
  }
  return wrapEncodedMap(out);
}

function encodedValuesEqual(a: unknown, b: unknown): boolean {
  const decodedA = decodeDocValue(a, OFFLINE_REF_DECODER, DOC_VALUE_ENCODING);
  const decodedB = decodeDocValue(b, OFFLINE_REF_DECODER, DOC_VALUE_ENCODING);
  return firestoreValuesEqual(decodedA, decodedB);
}

function resolveEncodedSentinels(
  node: unknown,
  priorRoot: Record<string, unknown> | null,
  prefix: readonly string[],
  nowSeconds: number,
  tsPaths: Array<readonly string[]>,
  keepDeletes: boolean,
): unknown {
  if (!isRecord(node)) {
    if (Array.isArray(node)) {
      return node.map((el) => resolveEncodedSentinels(el, priorRoot, [], nowSeconds, tsPaths, false));
    }
    return node;
  }
  if (isSentinel(node, 'deleteField')) {
    return DELETE_SENTINEL;
  }
  if (isSentinel(node, 'serverTimestamp')) {
    tsPaths.push(prefix);
    return { __type: 'timestamp', seconds: nowSeconds, nanos: 0 };
  }
  if (isSentinel(node, 'increment')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    return applyOfflineIncrement(prevVal, node.n);
  }
  if (isSentinel(node, 'maximum')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    return applyOfflineMaximum(prevVal, node.n);
  }
  if (isSentinel(node, 'minimum')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    return applyOfflineMinimum(prevVal, node.n);
  }
  if (isSentinel(node, 'arrayUnion')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    const result: unknown[] = [];
    if (Array.isArray(prevVal)) {
      for (const item of prevVal) result.push(item);
    }
    if (Array.isArray(node.values)) {
      for (const rawItem of node.values) {
        const resolvedItem = resolveEncodedSentinels(rawItem, priorRoot, [], nowSeconds, tsPaths, false);
        if (!result.some((existing) => encodedValuesEqual(existing, resolvedItem))) {
          result.push(resolvedItem);
        }
      }
    }
    return result;
  }
  if (isSentinel(node, 'arrayRemove')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    if (!Array.isArray(prevVal)) return [];
    const removals: unknown[] = [];
    if (Array.isArray(node.values)) {
      for (const rawItem of node.values) {
        removals.push(resolveEncodedSentinels(rawItem, priorRoot, [], nowSeconds, tsPaths, false));
      }
    }
    return prevVal.filter((existing) => !removals.some((rem) => encodedValuesEqual(existing, rem)));
  }
  const truncatedTs = truncateEncodedTimestamp(node);
  if (truncatedTs !== undefined) {
    return truncatedTs;
  }
  if (isEncodedScalar(node)) {
    return node;
  }
  const fields = unwrapEncodedMap(node);
  if (fields === undefined) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isSentinel(v, 'deleteField')) {
      if (keepDeletes) defineOwnField(out, k, DELETE_SENTINEL);
      continue;
    }
    defineOwnField(out, k, resolveEncodedSentinels(v, priorRoot, [...prefix, k], nowSeconds, tsPaths, keepDeletes));
  }
  return wrapEncodedMap(out);
}

function buildVariants(
  resolved: Record<string, unknown>,
  prior: Record<string, unknown> | null,
  tsPaths: ReadonlyArray<readonly string[]>,
): RawDocResult['serverTimestampVariants'] {
  if (tsPaths.length === 0) return undefined;
  let noneRoot = resolved;
  let prevRoot = resolved;
  for (const tsPath of tsPaths) {
    noneRoot = setEncodedField(noneRoot, tsPath, null);
    prevRoot = setEncodedField(prevRoot, tsPath, readEncodedAt(prior, tsPath).value);
  }
  return {
    none: { valueEncoding: DOC_VALUE_ENCODING, json: JSON.stringify(noneRoot) },
    previous: { valueEncoding: DOC_VALUE_ENCODING, json: JSON.stringify(prevRoot) },
  };
}

export function projectWorkerOfflineDoc(
  path: string,
  baseDoc: SerializedDocData | null | undefined,
  stagedEntries: ReadonlyArray<{ readonly mutations: readonly WorkerOfflineMutation[] }>,
): { readonly known: boolean; readonly result: RawDocResult } {
  let known = baseDoc !== undefined;
  let current: Record<string, unknown> | null = null;
  if (baseDoc !== undefined && baseDoc !== null) current = JSON.parse(baseDoc.json) as Record<string, unknown>;
  let hasPendingWrites = false;
  let serverTimestampVariants: RawDocResult['serverTimestampVariants'];
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const entry of stagedEntries) {
    for (const m of entry.mutations) {
      if (m.path !== path) continue;
      known = true;
      hasPendingWrites = true;
      serverTimestampVariants = undefined;
      if (m.kind === 'delete') { current = null; continue; }
      if (m.kind === 'update') {
        if (current === null) continue;
        const prior = current;
        let nextObj: Record<string, unknown> = current;
        const tsPaths: Array<readonly string[]> = [];
        for (const field of m.fields) {
          nextObj = setEncodedField(
            nextObj,
            field.path,
            resolveEncodedSentinels(field.value, prior, field.path, nowSeconds, tsPaths, false),
          );
        }
        current = nextObj;
        serverTimestampVariants = buildVariants(nextObj, prior, tsPaths);
        continue;
      }
      let incoming: Record<string, unknown> = {};
      if (isRecord(m.encodedData)) incoming = m.encodedData;
      const isMergeAll = m.options?.merge === true;
      const mergeFields = m.options?.mergeFields;
      const isMerge = isMergeAll || mergeFields !== undefined;
      const priorForSet = current;
      let tsPaths: Array<readonly string[]> = [];
      let resolved = resolveEncodedSentinels(incoming, priorForSet, [], nowSeconds, tsPaths, isMerge) as Record<string, unknown>;
      if (isMergeAll) {
        if (current !== null) {
          resolved = mergeEncodedMaps(current, resolved);
        } else {
          resolved = stripDeleteSentinels(resolved) as Record<string, unknown>;
        }
      } else if (mergeFields !== undefined) {
        const masks = mergeFields.map(fieldPathKeySegments);
        tsPaths = tsPaths.filter((cand) => masks.some((mask) => mask.length <= cand.length && mask.every((s, i) => cand[i] === s)));
        let masked: Record<string, unknown> = {};
        if (current !== null) masked = current;
        for (const mask of masks) {
          const picked = readEncodedAt(resolved, mask);
          if (picked.found && picked.value !== DELETE_SENTINEL) {
            masked = setEncodedField(masked, mask, stripDeleteSentinels(picked.value));
          } else {
            masked = setEncodedField(masked, mask, undefined);
          }
        }
        resolved = masked;
      }
      serverTimestampVariants = buildVariants(resolved, priorForSet, tsPaths);
      current = resolved;
    }
  }
  let data: SerializedDocData | undefined;
  if (current !== null) data = { valueEncoding: DOC_VALUE_ENCODING, json: JSON.stringify(current) };
  const result: RawDocResult = { id: lastSegment(path), path, exists: current !== null, data, fromCache: true, hasPendingWrites };
  if (serverTimestampVariants !== undefined) result.serverTimestampVariants = serverTimestampVariants;
  return { known, result };
}

export function projectWorkerOfflineQuery(
  target: TargetDescriptor,
  baseDocs: ReadonlyMap<string, SerializedDocData | null>,
  stagedEntries: ReadonlyArray<{ readonly mutations: readonly WorkerOfflineMutation[] }>,
): RawQueryResult {
  const allPaths = new Set<string>(baseDocs.keys());
  for (const entry of stagedEntries) {
    for (const m of entry.mutations) allPaths.add(m.path);
  }
  const docs: RawDocResult[] = [];
  for (const path of Array.from(allPaths).sort()) {
    if (!targetMatchesPath(target, path)) continue;
    const projected = projectWorkerOfflineDoc(path, baseDocs.get(path), stagedEntries);
    if (projected.result.exists) docs.push(projected.result);
  }
  const filteredDocs = filterWorkerOfflineQueryDocs(target, docs);
  return {
    docs: filteredDocs,
    fromCache: true,
    hasPendingWrites: filteredDocs.some((d) => d.hasPendingWrites === true),
  };
}
