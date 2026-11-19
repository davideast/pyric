/** Per-(port, instance) RTDB offline overlay tree and wire-snapshot synthesis. */
import {
  coerceArrays,
  evaluateQueryRead,
  executeQuery,
  loadsAllData,
  normalizeNode,
  resolveSentinels,
  writePriority,
  type Priority,
  type QuerySpec,
} from 'pyric/database/internal';
import type { RtdbQuerySpec } from '../protocol.js';
import type { ClientPort, ClientRtdbInstance } from './handles.js';
import { normalizeRtdbPath } from './rtdb-references.js';
import type { RtdbWireEntry, RtdbWireSnapshot } from './rtdb-snapshots.js';

export type OverlayJson =
  | null
  | boolean
  | number
  | string
  | OverlayJson[]
  | { [key: string]: OverlayJson };

export interface WorkerWriteOverlay {
  readonly paths: string[];
  readonly apply: (scope: WorkerOfflineScope) => void;
}

export interface WorkerQueuedAction {
  readonly kind: 'write' | 'disconnect' | 'transaction' | 'get';
  readonly execute: () => Promise<void>;
}

export interface WorkerOfflineListener {
  readonly path: string;
  readonly query: RtdbQuerySpec | undefined;
  readonly onlyOnce: boolean;
  readonly onWireFromOverlay: (wire: RtdbWireSnapshot) => void;
  deferredWire: RtdbWireSnapshot | undefined;
}

export interface WorkerOfflineScope {
  offline: boolean;
  serverTree: OverlayJson;
  frozenTree: OverlayJson;
  overlayTree: OverlayJson;
  readonly serverPriorities: Map<string, Priority>;
  readonly frozenPriorities: Map<string, Priority>;
  readonly overlayPriorities: Map<string, Priority>;
  readonly coveringWritePaths: Set<string>;
  readonly pendingOverlays: WorkerWriteOverlay[];
  readonly queuedActions: WorkerQueuedAction[];
  readonly listeners: Set<WorkerOfflineListener>;
}

const scopes = new WeakMap<ClientPort, Map<string, WorkerOfflineScope>>();

export interface WorkerInstanceScopeRef {
  readonly port: ClientPort;
  readonly instance?: ClientRtdbInstance;
}

export function dropWorkerOfflineStateForPort(port: ClientPort): void {
  scopes.delete(port);
}

export function scopeForWorker(handle: WorkerInstanceScopeRef): WorkerOfflineScope {
  let byInstance = scopes.get(handle.port);
  if (byInstance === undefined) {
    byInstance = new Map();
    scopes.set(handle.port, byInstance);
  }
  let key = '';
  if (handle.instance !== undefined && handle.instance.name !== undefined) {
    key = handle.instance.name;
  }
  let existing = byInstance.get(key);
  if (existing === undefined) {
    existing = {
      offline: false,
      serverTree: null,
      frozenTree: null,
      overlayTree: null,
      serverPriorities: new Map(),
      frozenPriorities: new Map(),
      overlayPriorities: new Map(),
      coveringWritePaths: new Set(),
      pendingOverlays: [],
      queuedActions: [],
      listeners: new Set(),
    };
    byInstance.set(key, existing);
  }
  return existing;
}

export function pathSegmentsOf(path: string): string[] {
  return normalizeRtdbPath(path).split('/').filter(Boolean);
}

export function joinChildPath(basePath: string, childKey: string): string {
  const normalized = normalizeRtdbPath(basePath);
  if (normalized === '/') {
    return `/${childKey}`;
  }
  return `${normalized}/${childKey}`;
}

export function workerPathsOverlap(left: string, right: string): boolean {
  if (left === '/' || right === '/' || left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function ancestorCovers(ancestor: string, targetPath: string): boolean {
  if (ancestor === '/' || ancestor === targetPath) {
    return true;
  }
  return targetPath.startsWith(`${ancestor}/`);
}

export function canServeWorkerOfflineGet(scope: WorkerOfflineScope, path: string): boolean {
  const canonical = normalizeRtdbPath(path);
  for (const listener of scope.listeners) {
    if (!listener.onlyOnce && ancestorCovers(listener.path, canonical)) {
      return true;
    }
  }
  for (const writePath of scope.coveringWritePaths) {
    if (ancestorCovers(writePath, canonical)) {
      return true;
    }
  }
  return false;
}

function isPlainRecord(val: OverlayJson): val is { [key: string]: OverlayJson } {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

export function treeRead(root: OverlayJson, path: string): OverlayJson {
  const segs = pathSegmentsOf(path);
  let cur: OverlayJson = root;
  for (const seg of segs) {
    if (!isPlainRecord(cur) || !Object.hasOwn(cur, seg)) {
      return null;
    }
    const next = cur[seg];
    if (next === undefined) {
      return null;
    }
    cur = next;
  }
  if (isPlainRecord(cur) && Object.keys(cur).length === 0) {
    return null;
  }
  return structuredClone(cur);
}

function writeSegments(
  parent: { [key: string]: OverlayJson },
  segs: readonly string[],
  idx: number,
  val: OverlayJson,
): { [key: string]: OverlayJson } | null {
  const key = segs[idx];
  if (key === undefined) {
    return parent;
  }
  let nextChild: OverlayJson = null;
  if (idx === segs.length - 1) {
    if (val !== null) {
      nextChild = structuredClone(val);
    }
  } else {
    let childObj: { [key: string]: OverlayJson } = {};
    if (Object.hasOwn(parent, key)) {
      const existing = parent[key];
      if (existing !== undefined && isPlainRecord(existing)) {
        childObj = existing;
      }
    }
    nextChild = writeSegments(childObj, segs, idx + 1, val);
  }
  const out: { [key: string]: OverlayJson } = {};
  let count = 0;
  for (const [k, v] of Object.entries(parent)) {
    if (k === key) {
      continue;
    }
    out[k] = v;
    count += 1;
  }
  if (nextChild !== null) {
    out[key] = nextChild;
    count += 1;
  }
  if (count === 0) {
    return null;
  }
  return out;
}

export function treeWrite(root: OverlayJson, path: string, val: OverlayJson): OverlayJson {
  const segs = pathSegmentsOf(path);
  if (segs.length === 0) {
    if (val === null) {
      return null;
    }
    return structuredClone(val);
  }
  let baseObj: { [key: string]: OverlayJson } = {};
  if (isPlainRecord(root)) {
    baseObj = root;
  }
  return writeSegments(baseObj, segs, 0, val);
}

export function normalizeWorkerSentinels(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const marker = value as { __rtdbSentinel?: unknown };
  if (marker.__rtdbSentinel === 'serverTimestamp') {
    return { '.sv': 'timestamp' };
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeWorkerSentinels(item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = normalizeWorkerSentinels(v);
  }
  return out;
}

export function applyOverlaySetToScope(
  scope: WorkerOfflineScope,
  path: string,
  rawValue: unknown,
  rawPriority: Priority,
  hasPriority: boolean,
  now: number,
): void {
  const canonical = normalizeRtdbPath(path);
  const currentRendered = coerceArrays(treeRead(scope.overlayTree, canonical) as never) as OverlayJson;
  const resolvedInput = resolveSentinels(normalizeWorkerSentinels(rawValue), now, currentRendered as never);
  const normalized = normalizeNode(resolvedInput) as OverlayJson;
  let basePrio: Priority = null;
  if (hasPriority) {
    let priorPrio: Priority = null;
    if (scope.overlayPriorities.has(canonical)) {
      const got = scope.overlayPriorities.get(canonical);
      if (got !== undefined) {
        priorPrio = got;
      }
    }
    basePrio = resolveSentinels(normalizeWorkerSentinels(rawPriority), now, priorPrio) as Priority;
  }
  const written = writePriority(resolvedInput, basePrio);
  scope.overlayTree = treeWrite(scope.overlayTree, canonical, normalized);
  if (normalized === null) {
    scope.overlayPriorities.set(canonical, null);
  } else {
    scope.overlayPriorities.set(canonical, written.priority);
  }
}

export function rebuildWorkerOverlay(scope: WorkerOfflineScope): void {
  scope.overlayPriorities.clear();
  if (scope.offline) {
    scope.overlayTree = structuredClone(scope.frozenTree);
    for (const [k, v] of scope.frozenPriorities) {
      scope.overlayPriorities.set(k, v);
    }
  } else {
    scope.overlayTree = structuredClone(scope.serverTree);
    for (const [k, v] of scope.serverPriorities) {
      scope.overlayPriorities.set(k, v);
    }
  }
  for (const overlay of scope.pendingOverlays) {
    overlay.apply(scope);
  }
}

function normalizeWireQuery(query: RtdbQuerySpec): QuerySpec {
  if (query.limit === null) {
    return { orderBy: query.orderBy, bounds: query.bounds, limit: null };
  }
  let count = Number.POSITIVE_INFINITY;
  if (query.limit.n !== null) {
    count = query.limit.n;
  }
  return { orderBy: query.orderBy, bounds: query.bounds, limit: { kind: query.limit.kind, n: count } };
}

function overlayPriorityAt(scope: WorkerOfflineScope, path: string): Priority {
  const canonical = normalizeRtdbPath(path);
  const got = scope.overlayPriorities.get(canonical);
  if (got === undefined) {
    return null;
  }
  return got;
}

function renderExportValue(
  scope: WorkerOfflineScope,
  nodePath: string,
  rawNode: OverlayJson,
  includeOwnPriority: boolean,
): OverlayJson {
  if (rawNode === null) {
    return null;
  }
  let prio: Priority = null;
  if (includeOwnPriority) {
    prio = overlayPriorityAt(scope, nodePath);
  }
  if (!isPlainRecord(rawNode)) {
    if (prio === null) {
      return rawNode;
    }
    return { '.value': rawNode, '.priority': prio };
  }
  const rows = executeQuery(
    rawNode as never,
    { orderBy: null, bounds: [], limit: null },
    (childKey) => overlayPriorityAt(scope, joinChildPath(nodePath, childKey)),
  );
  const out: { [key: string]: OverlayJson } = {};
  for (const row of rows) {
    out[row.key] = renderExportValue(
      scope,
      joinChildPath(nodePath, row.key),
      row.value as OverlayJson,
      true,
    );
  }
  if (prio !== null) {
    out['.priority'] = prio;
  }
  return out;
}

export function buildWireFromOverlay(
  scope: WorkerOfflineScope,
  path: string,
  wireQuery: RtdbQuerySpec | undefined,
): RtdbWireSnapshot {
  const canonical = normalizeRtdbPath(path);
  const segs = pathSegmentsOf(canonical);
  let key: string | null = null;
  if (segs.length > 0) {
    const last = segs[segs.length - 1];
    if (last !== undefined) {
      key = last;
    }
  }
  const rawNode = treeRead(scope.overlayTree, canonical);
  const prioForChild = (childKey: string): Priority =>
    overlayPriorityAt(scope, joinChildPath(canonical, childKey));

  if (wireQuery !== undefined) {
    const spec = normalizeWireQuery(wireQuery);
    const result = evaluateQueryRead(rawNode as never, spec, prioForChild);
    const unfiltered = loadsAllData(spec);
    const exists = result.val !== null;
    let priority: Priority = null;
    if (exists && unfiltered) {
      priority = overlayPriorityAt(scope, canonical);
    }
    const entries: RtdbWireEntry[] = result.rows.map((row) => ({
      key: row.key,
      value: coerceArrays(row.value),
      priority: row.priority,
      exportValue: renderExportValue(scope, joinChildPath(canonical, row.key), row.value as OverlayJson, true),
    }));
    return {
      key,
      exists,
      value: coerceArrays(result.val),
      priority,
      exportValue: renderExportValue(scope, canonical, result.val as OverlayJson, unfiltered),
      entries,
    };
  }

  const exists = rawNode !== null;
  let priority: Priority = null;
  if (exists) {
    priority = overlayPriorityAt(scope, canonical);
  }
  const ordered = executeQuery(rawNode as never, { orderBy: null, bounds: [], limit: null }, prioForChild);
  const entries: RtdbWireEntry[] = ordered.map((row) => ({
    key: row.key,
    value: coerceArrays(row.value),
    priority: row.priority,
    exportValue: renderExportValue(scope, joinChildPath(canonical, row.key), row.value as OverlayJson, true),
  }));
  return {
    key,
    exists,
    value: coerceArrays(rawNode as never),
    priority,
    exportValue: renderExportValue(scope, canonical, rawNode, true),
    entries,
  };
}

export function recordServerWireOnScope(
  scope: WorkerOfflineScope,
  path: string,
  wire: unknown,
  query: RtdbQuerySpec | undefined,
): void {
  if (query !== undefined && !loadsAllData(normalizeWireQuery(query))) {
    return;
  }
  const payload = wire as RtdbWireSnapshot | null;
  if (payload === null || typeof payload !== 'object') {
    return;
  }
  const canonical = normalizeRtdbPath(path);
  let rawVal: unknown = null;
  if (payload.value !== undefined) {
    rawVal = payload.value;
  }
  const normalized = normalizeNode(rawVal) as OverlayJson;
  scope.serverTree = treeWrite(scope.serverTree, canonical, normalized);
  if (payload.priority !== undefined && payload.priority !== null) {
    scope.serverPriorities.set(canonical, payload.priority);
  } else {
    scope.serverPriorities.delete(canonical);
  }
  if (payload.entries !== undefined) {
    for (const entry of payload.entries) {
      const childPath = joinChildPath(canonical, entry.key);
      if (entry.priority !== undefined && entry.priority !== null) {
        scope.serverPriorities.set(childPath, entry.priority);
      } else {
        scope.serverPriorities.delete(childPath);
      }
    }
  }
  if (!scope.offline) {
    rebuildWorkerOverlay(scope);
  }
}
