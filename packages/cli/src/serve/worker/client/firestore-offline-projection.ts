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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSentinel(value: unknown, kind: string): boolean {
  return isRecord(value) && value.__sentinel === kind;
}

function isEscapedMap(value: Record<string, unknown>): value is { type: 'pyric/map/1.0'; fields: Record<string, unknown> } {
  return value.type === 'pyric/map/1.0' && isRecord(value.fields);
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
    if (!isRecord(cur)) return { found: false, value: null };
    let fields: Record<string, unknown> = cur;
    if (isEscapedMap(cur)) fields = cur.fields;
    if (!Object.hasOwn(fields, seg)) return { found: false, value: null };
    cur = fields[seg];
  }
  if (cur === undefined) return { found: false, value: null };
  return { found: true, value: cur };
}

function setEncodedField(root: Record<string, unknown>, segments: readonly string[], value: unknown): Record<string, unknown> {
  const head = segments[0];
  if (head === undefined) return root;
  if (isEscapedMap(root)) return { type: 'pyric/map/1.0', fields: setEncodedField(root.fields, segments, value) };
  const out: Record<string, unknown> = { ...root };
  if (segments.length === 1) {
    if (isSentinel(value, 'deleteField') || value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  let nextChild: Record<string, unknown> = {};
  if (isRecord(out[head])) nextChild = out[head] as Record<string, unknown>;
  out[head] = setEncodedField(nextChild, segments.slice(1), value);
  return out;
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
): unknown {
  if (!isRecord(node)) {
    if (Array.isArray(node)) return node.map((el) => resolveEncodedSentinels(el, priorRoot, [], nowSeconds, tsPaths));
    return node;
  }
  if (isSentinel(node, 'serverTimestamp')) {
    tsPaths.push(prefix);
    return { __type: 'timestamp', seconds: nowSeconds, nanos: 0 };
  }
  if (isSentinel(node, 'increment')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    let addend = 0;
    if (typeof node.n === 'number') addend = node.n;
    let base = 0;
    if (typeof prevVal === 'number') base = prevVal;
    return base + addend;
  }
  if (isSentinel(node, 'arrayUnion')) {
    const prevVal = readEncodedAt(priorRoot, prefix).value;
    const result: unknown[] = [];
    if (Array.isArray(prevVal)) {
      for (const item of prevVal) result.push(item);
    }
    if (Array.isArray(node.values)) {
      for (const rawItem of node.values) {
        const resolvedItem = resolveEncodedSentinels(rawItem, priorRoot, [], nowSeconds, tsPaths);
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
        removals.push(resolveEncodedSentinels(rawItem, priorRoot, [], nowSeconds, tsPaths));
      }
    }
    return prevVal.filter((existing) => !removals.some((rem) => encodedValuesEqual(existing, rem)));
  }
  if (isEscapedMap(node)) {
    const fields = resolveEncodedSentinels(node.fields, priorRoot, prefix, nowSeconds, tsPaths) as Record<string, unknown>;
    return { type: 'pyric/map/1.0', fields };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (isSentinel(v, 'deleteField')) continue;
    out[k] = resolveEncodedSentinels(v, priorRoot, [...prefix, k], nowSeconds, tsPaths);
  }
  return out;
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
        let nextObj: Record<string, unknown> = { ...current };
        const tsPaths: Array<readonly string[]> = [];
        for (const field of m.fields) {
          nextObj = setEncodedField(nextObj, field.path, resolveEncodedSentinels(field.value, prior, field.path, nowSeconds, tsPaths));
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
      let priorForSet: Record<string, unknown> | null = null;
      if (isMerge) priorForSet = current;
      let tsPaths: Array<readonly string[]> = [];
      let resolved = resolveEncodedSentinels(incoming, priorForSet, [], nowSeconds, tsPaths) as Record<string, unknown>;
      if (isMergeAll && current !== null) {
        resolved = { ...current, ...resolved };
      } else if (!isMergeAll && mergeFields !== undefined) {
        const masks = mergeFields.map(fieldPathKeySegments);
        tsPaths = tsPaths.filter((cand) => masks.some((mask) => mask.length <= cand.length && mask.every((s, i) => cand[i] === s)));
        let masked: Record<string, unknown> = {};
        if (current !== null) masked = { ...current };
        for (const mask of masks) {
          const picked = readEncodedAt(resolved, mask);
          if (picked.found) masked = setEncodedField(masked, mask, picked.value);
          else masked = setEncodedField(masked, mask, undefined);
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
