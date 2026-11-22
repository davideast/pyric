/**
 * Per-handle path warmth, normalized value mirror, and priority mirror so
 * synchronous pass-0 `transaction` execution and warm `on('value')` listener
 * delivery match `@firebase/database` (`SyncTree` + `repoStartTransaction`).
 */

import {
  normalizeNode,
  resolveSentinels,
  writePriority,
  type Priority,
} from 'pyric/database/internal';
import { joinPath, pathSegments } from './tree-store.js';
import type { JsonValue } from './types.js';

export interface CachedSnapshotState {
  readonly stored: JsonValue;
  readonly exported: JsonValue;
}

export interface CacheMutationOptions {
  readonly sinceWireEpoch?: number;
  readonly allowColdWarming?: boolean;
  readonly now?: number;
}

interface RefreshedDescendantSnapshot {
  readonly path: string;
  readonly stored: JsonValue;
  readonly priorities: ReadonlyArray<readonly [string, string | number]>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function containsIncrementSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsIncrementSentinel(item)) {
        return true;
      }
    }
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '.sv')) {
    const sv = record['.sv'];
    return isPlainRecord(sv) && Object.hasOwn(sv, 'increment');
  }
  for (const key of Object.keys(record)) {
    if (containsIncrementSentinel(record[key])) {
      return true;
    }
  }
  return false;
}

function writeAtSegments(
  node: JsonValue,
  segs: readonly string[],
  index: number,
  leaf: JsonValue,
): JsonValue {
  if (index >= segs.length) {
    return leaf;
  }
  const key = segs[index];
  if (key === undefined) {
    return leaf;
  }
  const isObjectNode = node !== null && typeof node === 'object' && !Array.isArray(node);
  if (!isObjectNode && node !== null && leaf === null) {
    // Removing or setting null below a primitive leaf leaves the leaf intact (#1935).
    return node;
  }
  let baseRecord: Record<string, JsonValue> = {};
  if (isObjectNode) {
    baseRecord = { ...(node as Record<string, JsonValue>) };
  }
  let existingChild: JsonValue = null;
  if (Object.hasOwn(baseRecord, key)) {
    const ownVal = baseRecord[key];
    if (ownVal !== undefined) {
      existingChild = ownVal;
    }
  }
  const updatedChild = writeAtSegments(existingChild, segs, index + 1, leaf);
  if (updatedChild === null) {
    delete baseRecord[key];
  } else {
    baseRecord[key] = updatedChild;
  }
  if (Object.keys(baseRecord).length === 0) {
    return null;
  }
  return baseRecord;
}

export class AdminPathCache {
  private readonly warmCoverage = new Set<string>();
  private rootTree: JsonValue = null;
  private readonly priorities = new Map<string, string | number>();
  private wireEpoch = 0;
  private readonly wireCoverageEpochs = new Map<string, number>();

  currentWireEpoch(): number {
    return this.wireEpoch;
  }

  wasRefreshedByWireSince(canonical: string, sinceEpoch: number): boolean {
    if ((this.wireCoverageEpochs.get('/') ?? 0) > sinceEpoch) {
      return true;
    }
    if ((this.wireCoverageEpochs.get(canonical) ?? 0) > sinceEpoch) {
      return true;
    }
    const segs = pathSegments(canonical);
    for (let i = 1; i < segs.length; i += 1) {
      const ancestor = joinPath(segs.slice(0, i));
      if ((this.wireCoverageEpochs.get(ancestor) ?? 0) > sinceEpoch) {
        return true;
      }
    }
    return false;
  }

  isWarm(canonical: string): boolean {
    if (this.warmCoverage.has('/') || this.warmCoverage.has(canonical)) {
      return true;
    }
    const segs = pathSegments(canonical);
    for (let i = 1; i < segs.length; i += 1) {
      const ancestor = joinPath(segs.slice(0, i));
      if (this.warmCoverage.has(ancestor)) {
        return true;
      }
    }
    return false;
  }

  read(canonical: string): JsonValue {
    const segs = pathSegments(canonical);
    let cursor: JsonValue = this.rootTree;
    for (const seg of segs) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return null;
      }
      const record = cursor as Record<string, JsonValue>;
      if (!Object.hasOwn(record, seg)) {
        return null;
      }
      const next = record[seg];
      if (next === undefined) {
        return null;
      }
      cursor = next;
    }
    return cursor;
  }

  readSnapshot(canonical: string): CachedSnapshotState {
    const stored = this.read(canonical);
    const exported = this.buildExportAt(canonical, stored);
    return { stored, exported };
  }

  markWarm(canonical: string): void {
    this.warmCoverage.add(canonical);
  }

  recordValue(canonical: string, stored: JsonValue): void {
    this.recordSet(canonical, stored);
  }

  recordWireSnapshot(
    canonical: string,
    wire: { readonly value?: unknown; readonly exportValue?: unknown },
  ): void {
    this.wireEpoch += 1;
    this.wireCoverageEpochs.set(canonical, this.wireEpoch);
    const stored = normalizeNode(wire.value ?? null);
    this.writeStoredAt(canonical, stored, true);
    this.clearPrioritiesInSubtree(canonical);
    this.ingestExportPriorities(canonical, stored, wire.exportValue);
    this.pruneOrphanPriorities();
  }

  evictSubtree(canonical: string): void {
    if (canonical === '/') {
      this.warmCoverage.clear();
      this.rootTree = null;
      this.priorities.clear();
      return;
    }
    const prefix = `${canonical}/`;
    for (const covered of [...this.warmCoverage]) {
      if (covered === canonical || covered.startsWith(prefix)) {
        this.warmCoverage.delete(covered);
      }
    }
    this.writeStoredAt(canonical, null, false);
    this.clearPrioritiesInSubtree(canonical);
    this.pruneOrphanPriorities();
  }

  recordSet(
    canonical: string,
    payload: JsonValue,
    explicitPriority?: Priority,
    options?: CacheMutationOptions,
  ): void {
    const sinceWireEpoch = options?.sinceWireEpoch;
    if (sinceWireEpoch !== undefined && this.wasRefreshedByWireSince(canonical, sinceWireEpoch)) {
      return;
    }
    let refreshedDescendants: RefreshedDescendantSnapshot[] = [];
    if (sinceWireEpoch !== undefined) {
      refreshedDescendants = this.snapshotRefreshedDescendants(canonical, sinceWireEpoch);
    }
    const allowColdWarming = options?.allowColdWarming ?? true;
    const wasWarmBefore = this.isWarm(canonical);
    const hasIncrement =
      containsIncrementSentinel(payload) || containsIncrementSentinel(explicitPriority);
    if (!wasWarmBefore && (!allowColdWarming || hasIncrement)) {
      this.evictSubtree(canonical);
      this.restoreRefreshedDescendants(refreshedDescendants);
      return;
    }
    const now = options?.now ?? Date.now();
    const priorExported = this.buildExportAt(canonical, this.read(canonical));
    const priorPriority = this.priorities.get(canonical) ?? null;
    const resolvedPayload = resolveSentinels(payload, now, priorExported);
    const resolvedExplicit = resolveSentinels(
      explicitPriority ?? null,
      now,
      priorPriority,
    ) as Priority;
    const stored = normalizeNode(resolvedPayload);
    this.writeStoredAt(canonical, stored, true);
    this.clearPrioritiesInSubtree(canonical);
    if (stored !== null) {
      const extracted = writePriority(resolvedPayload, resolvedExplicit);
      if (typeof extracted.priority === 'string' || typeof extracted.priority === 'number') {
        this.priorities.set(canonical, extracted.priority);
      }
      const baseSegs = pathSegments(canonical);
      for (const nested of extracted.nested) {
        const nestedPath = joinPath([...baseSegs, ...nested.segments]);
        const nestedPriority = nested.priority;
        const isConcrete =
          typeof nestedPriority === 'string' || typeof nestedPriority === 'number';
        if (isConcrete && this.read(nestedPath) !== null) {
          this.priorities.set(nestedPath, nestedPriority);
        }
      }
    }
    this.restoreRefreshedDescendants(refreshedDescendants);
    this.pruneOrphanPriorities();
  }

  recordPriority(canonical: string, priority: Priority, options?: CacheMutationOptions): void {
    const sinceWireEpoch = options?.sinceWireEpoch;
    if (sinceWireEpoch !== undefined && this.wasRefreshedByWireSince(canonical, sinceWireEpoch)) {
      return;
    }
    const allowColdWarming = options?.allowColdWarming ?? true;
    if (!this.isWarm(canonical) && (!allowColdWarming || containsIncrementSentinel(priority))) {
      this.priorities.delete(canonical);
      return;
    }
    const now = options?.now ?? Date.now();
    const priorPriority = this.priorities.get(canonical) ?? null;
    const resolved = resolveSentinels(priority, now, priorPriority);
    const isConcrete = typeof resolved === 'string' || typeof resolved === 'number';
    if (!isConcrete || this.read(canonical) === null) {
      this.priorities.delete(canonical);
      return;
    }
    this.priorities.set(canonical, resolved);
  }

  recordPatch(
    canonical: string,
    patch: Record<string, JsonValue>,
    options?: CacheMutationOptions,
  ): void {
    const baseSegs = pathSegments(canonical);
    const priorityUpdates: Array<{ nodePath: string; priority: Priority }> = [];
    for (const [relKey, val] of Object.entries(patch)) {
      const relSegs = pathSegments(relKey);
      const lastSeg = relSegs[relSegs.length - 1];
      if (lastSeg === '.priority') {
        const nodePath = joinPath([...baseSegs, ...relSegs.slice(0, -1)]);
        priorityUpdates.push({ nodePath, priority: val as Priority });
      } else {
        const targetPath = joinPath([...baseSegs, ...relSegs]);
        this.recordSet(targetPath, val, undefined, options);
      }
    }
    for (const { nodePath, priority } of priorityUpdates) {
      this.recordPriority(nodePath, priority, options);
    }
  }

  reset(): void {
    this.warmCoverage.clear();
    this.rootTree = null;
    this.priorities.clear();
    this.wireCoverageEpochs.clear();
  }

  private snapshotRefreshedDescendants(
    canonical: string,
    sinceEpoch: number,
  ): RefreshedDescendantSnapshot[] {
    const matchingPaths: string[] = [];
    const prefix = `${canonical}/`;
    for (const [subPath, epoch] of this.wireCoverageEpochs.entries()) {
      let isDescendant = false;
      if (canonical === '/') {
        isDescendant = subPath !== '/';
      } else {
        isDescendant = subPath.startsWith(prefix);
      }
      if (epoch > sinceEpoch && isDescendant) {
        matchingPaths.push(subPath);
      }
    }
    matchingPaths.sort((a, b) => pathSegments(a).length - pathSegments(b).length);
    const snapshots: RefreshedDescendantSnapshot[] = [];
    for (const subPath of matchingPaths) {
      const subPrefix = `${subPath}/`;
      const savedPriorities: Array<readonly [string, string | number]> = [];
      for (const [prioPath, prioVal] of this.priorities.entries()) {
        if (prioPath === subPath || prioPath.startsWith(subPrefix)) {
          savedPriorities.push([prioPath, prioVal]);
        }
      }
      snapshots.push({
        path: subPath,
        stored: structuredClone(this.read(subPath)),
        priorities: savedPriorities,
      });
    }
    return snapshots;
  }

  private restoreRefreshedDescendants(
    snapshots: readonly RefreshedDescendantSnapshot[],
  ): void {
    for (const snap of snapshots) {
      this.writeStoredAt(snap.path, snap.stored, true);
      this.clearPrioritiesInSubtree(snap.path);
      for (const [prioPath, prioVal] of snap.priorities) {
        this.priorities.set(prioPath, prioVal);
      }
    }
  }

  private writeStoredAt(canonical: string, stored: JsonValue, markWarm: boolean): void {
    if (markWarm) {
      this.warmCoverage.add(canonical);
    }
    const segs = pathSegments(canonical);
    const cloned = structuredClone(stored);
    if (segs.length === 0) {
      this.rootTree = cloned;
      return;
    }
    this.rootTree = writeAtSegments(this.rootTree, segs, 0, cloned);
  }

  private clearPrioritiesInSubtree(canonical: string): void {
    if (canonical === '/') {
      this.priorities.clear();
      return;
    }
    const prefix = `${canonical}/`;
    for (const key of [...this.priorities.keys()]) {
      if (key === canonical || key.startsWith(prefix)) {
        this.priorities.delete(key);
      }
    }
  }

  private ingestExportPriorities(
    canonical: string,
    stored: JsonValue,
    exported: unknown,
  ): void {
    if (stored === null || !isPlainRecord(exported)) {
      return;
    }
    if (Object.hasOwn(exported, '.priority')) {
      const rawPrio = exported['.priority'];
      if (typeof rawPrio === 'string' || typeof rawPrio === 'number') {
        this.priorities.set(canonical, rawPrio);
      }
    }
    if (typeof stored !== 'object' || Array.isArray(stored)) {
      return;
    }
    const hasWrappedValue = Object.hasOwn(exported, '.value');
    for (const [childKey, childStored] of Object.entries(stored)) {
      let childExport: unknown;
      if (hasWrappedValue) {
        const inner = exported['.value'];
        if (isPlainRecord(inner) && Object.hasOwn(inner, childKey)) {
          childExport = inner[childKey];
        }
      } else if (Object.hasOwn(exported, childKey)) {
        childExport = exported[childKey];
      }
      let childPath = `/${childKey}`;
      if (canonical !== '/') {
        childPath = `${canonical}/${childKey}`;
      }
      this.ingestExportPriorities(childPath, childStored, childExport);
    }
  }

  private pruneOrphanPriorities(): void {
    for (const path of [...this.priorities.keys()]) {
      if (this.read(path) === null) {
        this.priorities.delete(path);
      }
    }
  }

  private buildExportAt(path: string, val: JsonValue): JsonValue {
    if (val === null) {
      return null;
    }
    const ownPrio = this.priorities.get(path) ?? null;
    if (typeof val !== 'object' || Array.isArray(val)) {
      if (ownPrio === null) {
        return val;
      }
      return { '.value': val, '.priority': ownPrio };
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, childVal] of Object.entries(val)) {
      let childPath = `/${key}`;
      if (path !== '/') {
        childPath = `${path}/${key}`;
      }
      out[key] = this.buildExportAt(childPath, childVal);
    }
    if (ownPrio !== null) {
      out['.priority'] = ownPrio;
    }
    return out;
  }
}
