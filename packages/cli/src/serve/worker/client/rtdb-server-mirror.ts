/**
 * Authoritative server-mirror reconciliation and wire-epoch tracking for the
 * served worker RTDB client. Prevents double-applying `increment(delta)` when
 * an active listener receives the host's post-write snapshot before the write
 * RPC promise settles, avoids fabricating `0 + delta` on cold `increment`
 * writes, and tracks which paths hold complete subtree coverage for warm
 * synchronous `runTransaction` pass-0 inputs.
 */
import { resolveSentinels, type Priority } from 'pyric/database/internal';
import { sandboxNow } from './clock.js';
import type { RtdbRefHandle } from './handles.js';
import {
  ancestorCovers,
  applyOverlaySetToScope,
  applySetToTreeAndPriorities,
  buildWireFromOverlay,
  clearPrioritiesAtOrBelow,
  normalizeWorkerSentinels,
  pathSegmentsOf,
  rebuildWorkerOverlay,
  scopeForWorker,
  treeRead,
  treeWrite,
  type OverlayJson,
  type WorkerOfflineScope,
  type WorkerOnlineInFlightEntry,
} from './rtdb-offline-overlay.js';
import { normalizeRtdbPath } from './rtdb-references.js';
import type { RtdbWireSnapshot } from './rtdb-snapshots.js';

interface RefreshedDescendantSnapshot {
  readonly path: string;
  readonly stored: OverlayJson;
  readonly priorities: ReadonlyArray<readonly [string, Priority]>;
}

function containsIncrementSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const marker = value as { __rtdbSentinel?: unknown };
  if (marker.__rtdbSentinel === 'serverTimestamp') {
    return false;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (i in value && containsIncrementSentinel(value[i])) {
        return true;
      }
    }
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '.sv')) {
    const op = record['.sv'];
    if (typeof op === 'object' && op !== null && Object.hasOwn(op, 'increment')) {
      return true;
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === '.sv') continue;
    if (containsIncrementSentinel(child)) {
      return true;
    }
  }
  return false;
}

function hasAuthoritativeCoverage(scope: WorkerOfflineScope, path: string): boolean {
  const canonical = normalizeRtdbPath(path);
  if (scope.authoritativePaths.has('/') || scope.authoritativePaths.has(canonical)) {
    return true;
  }
  const segs = pathSegmentsOf(canonical);
  for (let i = 1; i < segs.length; i += 1) {
    const ancestor = `/${segs.slice(0, i).join('/')}`;
    if (scope.authoritativePaths.has(ancestor)) {
      return true;
    }
  }
  return false;
}

function wasRefreshedByWireSince(
  scope: WorkerOfflineScope,
  canonical: string,
  sinceEpoch: number,
): boolean {
  if ((scope.wireCoverageEpochs.get('/') ?? 0) > sinceEpoch) {
    return true;
  }
  if ((scope.wireCoverageEpochs.get(canonical) ?? 0) > sinceEpoch) {
    return true;
  }
  const segs = pathSegmentsOf(canonical);
  for (let i = 1; i < segs.length; i += 1) {
    const ancestor = `/${segs.slice(0, i).join('/')}`;
    if ((scope.wireCoverageEpochs.get(ancestor) ?? 0) > sinceEpoch) {
      return true;
    }
  }
  return false;
}

function snapshotRefreshedDescendants(
  scope: WorkerOfflineScope,
  canonical: string,
  sinceEpoch: number,
): RefreshedDescendantSnapshot[] {
  const matching: string[] = [];
  const prefix = `${canonical}/`;
  for (const [subPath, epoch] of scope.wireCoverageEpochs.entries()) {
    let isDescendant = false;
    if (canonical === '/') {
      isDescendant = subPath !== '/';
    } else {
      isDescendant = subPath.startsWith(prefix);
    }
    if (epoch > sinceEpoch && isDescendant) {
      matching.push(subPath);
    }
  }
  matching.sort((a, b) => pathSegmentsOf(a).length - pathSegmentsOf(b).length);
  const snapshots: RefreshedDescendantSnapshot[] = [];
  for (const subPath of matching) {
    const subPrefix = `${subPath}/`;
    const savedPriorities: Array<readonly [string, Priority]> = [];
    for (const [prioPath, prioVal] of scope.serverPriorities.entries()) {
      if (prioPath === subPath || prioPath.startsWith(subPrefix)) {
        savedPriorities.push([prioPath, prioVal]);
      }
    }
    snapshots.push({
      path: subPath,
      stored: treeRead(scope.serverTree, subPath),
      priorities: savedPriorities,
    });
  }
  return snapshots;
}

function restoreRefreshedDescendants(
  scope: WorkerOfflineScope,
  snapshots: readonly RefreshedDescendantSnapshot[],
): void {
  for (const snap of snapshots) {
    scope.serverTree = treeWrite(scope.serverTree, snap.path, snap.stored);
    clearPrioritiesAtOrBelow(scope.serverPriorities, snap.path);
    for (const [prioPath, prioVal] of snap.priorities) {
      scope.serverPriorities.set(prioPath, prioVal);
    }
    scope.authoritativePaths.add(snap.path);
  }
}

function evictAuthoritativeSubtree(scope: WorkerOfflineScope, canonical: string): void {
  if (canonical === '/') {
    scope.authoritativePaths.clear();
    scope.serverTree = null;
    scope.serverPriorities.clear();
    return;
  }
  const prefix = `${canonical}/`;
  for (const covered of [...scope.authoritativePaths]) {
    if (covered === canonical || covered.startsWith(prefix)) {
      scope.authoritativePaths.delete(covered);
    }
  }
  scope.serverTree = treeWrite(scope.serverTree, canonical, null);
  clearPrioritiesAtOrBelow(scope.serverPriorities, canonical);
}

function reconcileServerSetOnScope(
  scope: WorkerOfflineScope,
  path: string,
  rawValue: unknown,
  rawPriority: Priority,
  hasPriority: boolean,
  now: number,
  sinceEpoch: number,
): void {
  const canonical = normalizeRtdbPath(path);
  if (wasRefreshedByWireSince(scope, canonical, sinceEpoch)) {
    return;
  }
  const refreshedDescendants = snapshotRefreshedDescendants(scope, canonical, sinceEpoch);
  const wasAuthoritative = hasAuthoritativeCoverage(scope, canonical);
  const hasIncrement =
    containsIncrementSentinel(rawValue) || (hasPriority && containsIncrementSentinel(rawPriority));
  if (!wasAuthoritative && hasIncrement) {
    evictAuthoritativeSubtree(scope, canonical);
    restoreRefreshedDescendants(scope, refreshedDescendants);
    if (!scope.offline) {
      rebuildWorkerOverlay(scope);
    }
    return;
  }
  scope.serverTree = applySetToTreeAndPriorities(
    scope.serverTree,
    scope.serverPriorities,
    canonical,
    rawValue,
    rawPriority,
    hasPriority,
    now,
  );
  scope.authoritativePaths.add(canonical);
  restoreRefreshedDescendants(scope, refreshedDescendants);
  if (!scope.offline) {
    rebuildWorkerOverlay(scope);
  }
}

function reconcileServerPriorityOnScope(
  scope: WorkerOfflineScope,
  path: string,
  rawPriority: Priority,
  now: number,
  sinceEpoch: number,
): void {
  const canonical = normalizeRtdbPath(path);
  if (wasRefreshedByWireSince(scope, canonical, sinceEpoch)) {
    return;
  }
  if (!hasAuthoritativeCoverage(scope, canonical)) {
    scope.serverPriorities.delete(canonical);
    return;
  }
  if (treeRead(scope.serverTree, canonical) === null) {
    scope.serverPriorities.delete(canonical);
    return;
  }
  let priorPrio: Priority = null;
  const existing = scope.serverPriorities.get(canonical);
  if (existing !== undefined) {
    priorPrio = existing;
  }
  const resolved = resolveSentinels(normalizeWorkerSentinels(rawPriority), now, priorPrio) as Priority;
  if (resolved === null) {
    scope.serverPriorities.delete(canonical);
  } else {
    scope.serverPriorities.set(canonical, resolved);
  }
  if (!scope.offline) {
    rebuildWorkerOverlay(scope);
  }
}

export function readAuthoritativeWarmTransactionWire(ref: RtdbRefHandle): RtdbWireSnapshot | undefined {
  const scope = scopeForWorker(ref);
  const canonical = normalizeRtdbPath(ref.path);
  let covered = hasAuthoritativeCoverage(scope, canonical);
  for (const entry of scope.onlineInFlightOverlays) {
    for (const op of entry.ops) {
      const coversTarget = ancestorCovers(op.path, canonical);
      const isDescendant = ancestorCovers(canonical, op.path);
      if ((coversTarget || isDescendant) && op.hasIncrement && !covered) {
        return undefined;
      }
      if (coversTarget && op.overwritesSubtree && !op.hasIncrement) {
        covered = true;
      }
    }
  }
  if (!covered) {
    return undefined;
  }
  if (scope.onlineInFlightOverlays.length === 0) {
    return buildWireFromOverlay(scope, canonical, undefined);
  }
  const tempPriorities = new Map<string, Priority>(scope.overlayPriorities);
  const tempScope: WorkerOfflineScope = {
    ...scope,
    overlayTree: structuredClone(scope.overlayTree),
    overlayPriorities: tempPriorities,
  };
  for (const entry of scope.onlineInFlightOverlays) {
    entry.apply(tempScope);
  }
  return buildWireFromOverlay(tempScope, canonical, undefined);
}

function trackOnlineWrite(
  ref: RtdbRefHandle,
  entry: WorkerOnlineInFlightEntry,
  onSettled: (scope: WorkerOfflineScope, sinceEpoch: number) => void,
  send: () => Promise<void>,
): Promise<void> {
  const scope = scopeForWorker(ref);
  const sinceEpoch = scope.wireEpoch;
  scope.onlineInFlightOverlays.push(entry);
  return send().then(
    () => {
      const idx = scope.onlineInFlightOverlays.indexOf(entry);
      if (idx >= 0) scope.onlineInFlightOverlays.splice(idx, 1);
      onSettled(scope, sinceEpoch);
    },
    (err) => {
      const idx = scope.onlineInFlightOverlays.indexOf(entry);
      if (idx >= 0) scope.onlineInFlightOverlays.splice(idx, 1);
      throw err;
    },
  );
}

export function sendWorkerOnlineSet(
  ref: RtdbRefHandle,
  path: string,
  value: unknown,
  priority: Priority,
  hasPriority: boolean,
  send: () => Promise<void>,
): Promise<void> {
  const canonical = normalizeRtdbPath(path);
  const now = sandboxNow();
  const hasIncrement =
    containsIncrementSentinel(value) || (hasPriority && containsIncrementSentinel(priority));
  const entry: WorkerOnlineInFlightEntry = {
    ops: [{ path: canonical, overwritesSubtree: true, hasIncrement }],
    apply: (sc) => applyOverlaySetToScope(sc, canonical, value, priority, hasPriority, now),
  };
  return trackOnlineWrite(
    ref,
    entry,
    (sc, sinceEpoch) => reconcileServerSetOnScope(sc, canonical, value, priority, hasPriority, now, sinceEpoch),
    send,
  );
}

export function sendWorkerOnlineSetPriority(
  ref: RtdbRefHandle,
  path: string,
  priority: Priority,
  send: () => Promise<void>,
): Promise<void> {
  const canonical = normalizeRtdbPath(path);
  const now = sandboxNow();
  const hasIncrement = containsIncrementSentinel(priority);
  const entry: WorkerOnlineInFlightEntry = {
    ops: [{ path: canonical, overwritesSubtree: false, hasIncrement }],
    apply: (sc) => {
      if (treeRead(sc.overlayTree, canonical) !== null) {
        const prior = sc.overlayPriorities.get(canonical) ?? null;
        const resolved = resolveSentinels(normalizeWorkerSentinels(priority), now, prior) as Priority;
        if (resolved === null) {
          sc.overlayPriorities.delete(canonical);
        } else {
          sc.overlayPriorities.set(canonical, resolved);
        }
      }
    },
  };
  return trackOnlineWrite(
    ref,
    entry,
    (sc, sinceEpoch) => reconcileServerPriorityOnScope(sc, canonical, priority, now, sinceEpoch),
    send,
  );
}

export function sendWorkerOnlineUpdate(
  ref: RtdbRefHandle,
  path: string,
  values: Record<string, unknown>,
  send: () => Promise<void>,
): Promise<void> {
  const baseSegs = pathSegmentsOf(path);
  const now = sandboxNow();
  const ops: Array<{ path: string; overwritesSubtree: boolean; hasIncrement: boolean }> = [];
  for (const [key, rawVal] of Object.entries(values)) {
    const segs = [...baseSegs, ...pathSegmentsOf(key)];
    if (segs.at(-1) === '.priority') {
      const nodePath = normalizeRtdbPath(`/${segs.slice(0, -1).join('/')}`);
      ops.push({ path: nodePath, overwritesSubtree: false, hasIncrement: containsIncrementSentinel(rawVal) });
    } else {
      const absPath = normalizeRtdbPath(`/${segs.join('/')}`);
      ops.push({ path: absPath, overwritesSubtree: true, hasIncrement: containsIncrementSentinel(rawVal) });
    }
  }
  const entry: WorkerOnlineInFlightEntry = {
    ops,
    apply: (sc) => {
      for (const [key, rawVal] of Object.entries(values)) {
        const segs = [...baseSegs, ...pathSegmentsOf(key)];
        if (segs.at(-1) === '.priority') {
          const nodePath = normalizeRtdbPath(`/${segs.slice(0, -1).join('/')}`);
          if (treeRead(sc.overlayTree, nodePath) !== null) {
            const prior = sc.overlayPriorities.get(nodePath) ?? null;
            const resolved = resolveSentinels(normalizeWorkerSentinels(rawVal), now, prior) as Priority;
            if (resolved === null) {
              sc.overlayPriorities.delete(nodePath);
            } else {
              sc.overlayPriorities.set(nodePath, resolved);
            }
          }
          continue;
        }
        applyOverlaySetToScope(sc, normalizeRtdbPath(`/${segs.join('/')}`), rawVal, null, false, now);
      }
    },
  };
  return trackOnlineWrite(
    ref,
    entry,
    (sc, sinceEpoch) => {
      const prioOps: Array<{ nodePath: string; rawVal: unknown }> = [];
      for (const [key, rawVal] of Object.entries(values)) {
        const segs = [...baseSegs, ...pathSegmentsOf(key)];
        if (segs.at(-1) === '.priority') {
          prioOps.push({ nodePath: normalizeRtdbPath(`/${segs.slice(0, -1).join('/')}`), rawVal });
        } else {
          reconcileServerSetOnScope(sc, normalizeRtdbPath(`/${segs.join('/')}`), rawVal, null, false, now, sinceEpoch);
        }
      }
      for (const prioOp of prioOps) {
        reconcileServerPriorityOnScope(sc, prioOp.nodePath, prioOp.rawVal as Priority, now, sinceEpoch);
      }
    },
    send,
  );
}
