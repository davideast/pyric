/**
 * Bounded, fail-closed tracker of active in-flight Realtime Database writes so
 * listener deliveries and one-shot reads that observe optimistic local state
 * before settlement emit `invalidate` rather than promoting unconfirmed values
 * to authoritative session coverage.
 *
 * When a write remains unsettled past `DEFAULT_INFLIGHT_LEASE_TTL_MS` or when
 * concurrent unsettled writes exceed `MAX_ACTIVE_INFLIGHT_WRITES`, the evicted
 * path-scoped lease folds into a bounded per-instance fail-closed taint counter
 * (`MAX_TAINTED_INSTANCES`, with a scalar global fallback) that continues to
 * emit `invalidate` until the original `release()` settles.
 */
import { normalizeInFlightRtdbPath, planRtdbWritePaths, type RtdbWritePlanInput } from './rtdb-write-plan.js';
import type { CallLifecycleLease, ObservedRtdbSessionOp, ObservedSessionDelta } from './session-data.js';

/** Active path-scoped lease lifetime (ms) before folding into per-instance fail-closed taint. */
export const DEFAULT_INFLIGHT_LEASE_TTL_MS = 30_000;

/** Upper bound on path-scoped active write leases retained concurrently. */
export const MAX_ACTIVE_INFLIGHT_WRITES = 256;

/** Upper bound on distinct per-instance overflow taint counters before scalar global fallback. */
export const MAX_TAINTED_INSTANCES = 64;

type LeaseState = 'active' | 'overflow-instance' | 'overflow-global' | 'settled';

interface InFlightWriteEntry {
  readonly instance: string;
  paths: readonly string[];
  readonly expiresAt: number;
  state: LeaseState;
}

export interface InFlightLeaseOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface InFlightTrackerOptions {
  readonly unreadInstance: string;
  readonly maxActiveWrites?: number;
  readonly maxTaintedInstances?: number;
}

export type InFlightRtdbOverlap =
  | { readonly kind: 'none' }
  | { readonly kind: 'covered' }
  | { readonly kind: 'descendants'; readonly paths: readonly string[] };

export interface InFlightRtdbWriteTracker {
  createWriteStarter(
    instance: string,
    initialPaths: readonly string[],
    resolveNarrowedPath?: (returned: unknown) => string | undefined,
    options?: InFlightLeaseOptions,
  ): (() => CallLifecycleLease) | undefined;
  writeLeaseStarter(input: RtdbWritePlanInput): (() => CallLifecycleLease) | undefined;
  overlapOf(instance: string, deliveryPath: string, now?: () => number): InFlightRtdbOverlap;
  applyDeliveryGuard(
    instance: string,
    deliveryPath: string,
    computeBaseDelta: () => ObservedSessionDelta | undefined,
    now?: () => number,
  ): ObservedSessionDelta | undefined;
}

function isRtdbPrefixOrSame(prefix: string, target: string): boolean {
  if (prefix === '/') return true;
  return target === prefix || target.startsWith(`${prefix}/`);
}

/** Creates an isolated, bounded, fail-closed in-flight RTDB write tracker. */
export function createInFlightRtdbWriteTracker(options: InFlightTrackerOptions): InFlightRtdbWriteTracker {
  const unreadInstance = options.unreadInstance;
  const maxActiveWrites = options.maxActiveWrites ?? MAX_ACTIVE_INFLIGHT_WRITES;
  const maxTaintedInstances = options.maxTaintedInstances ?? MAX_TAINTED_INSTANCES;
  const activeWrites = new Set<InFlightWriteEntry>();
  const instanceOverflowTaint = new Map<string, number>();
  let globalOverflowTaintCount = 0;

  function sameOrUnknownInstance(left: string, right: string): boolean {
    return left === right || left === unreadInstance || right === unreadInstance;
  }

  function demoteToFailClosedTaint(entry: InFlightWriteEntry): void {
    activeWrites.delete(entry);
    entry.paths = [];
    const existing = instanceOverflowTaint.get(entry.instance);
    if (existing !== undefined) {
      instanceOverflowTaint.set(entry.instance, existing + 1);
      entry.state = 'overflow-instance';
      return;
    }
    if (instanceOverflowTaint.size < maxTaintedInstances) {
      instanceOverflowTaint.set(entry.instance, 1);
      entry.state = 'overflow-instance';
      return;
    }
    globalOverflowTaintCount += 1;
    entry.state = 'overflow-global';
  }

  function releaseOverflowTaint(instance: string): void {
    const current = instanceOverflowTaint.get(instance);
    if (current === undefined) return;
    if (current <= 1) {
      instanceOverflowTaint.delete(instance);
      return;
    }
    instanceOverflowTaint.set(instance, current - 1);
  }

  function pruneExpiredWrites(nowMs: number): void {
    for (const entry of activeWrites) {
      if (entry.expiresAt <= nowMs) {
        demoteToFailClosedTaint(entry);
      }
    }
  }

  function enforceActiveWriteCap(): void {
    while (activeWrites.size >= maxActiveWrites) {
      const oldest = activeWrites.values().next();
      if (oldest.done) break;
      demoteToFailClosedTaint(oldest.value);
    }
  }

  function hasOverflowTaintFor(instance: string): boolean {
    if (globalOverflowTaintCount > 0) return true;
    if (instanceOverflowTaint.size === 0) return false;
    if (instance === unreadInstance) return true;
    if ((instanceOverflowTaint.get(instance) ?? 0) > 0) return true;
    return (instanceOverflowTaint.get(unreadInstance) ?? 0) > 0;
  }

  function overlapOf(instance: string, deliveryPath: string, now: () => number = Date.now): InFlightRtdbOverlap {
    pruneExpiredWrites(now());
    if (hasOverflowTaintFor(instance)) return { kind: 'covered' };
    if (activeWrites.size === 0) return { kind: 'none' };
    const target = normalizeInFlightRtdbPath(deliveryPath);
    const descendants = new Set<string>();
    for (const entry of activeWrites) {
      if (!sameOrUnknownInstance(entry.instance, instance)) continue;
      for (const writePath of entry.paths) {
        if (isRtdbPrefixOrSame(writePath, target)) return { kind: 'covered' };
        if (isRtdbPrefixOrSame(target, writePath)) descendants.add(writePath);
      }
    }
    if (descendants.size > 0) return { kind: 'descendants', paths: [...descendants] };
    return { kind: 'none' };
  }

  function createWriteStarter(
    instance: string,
    initialPaths: readonly string[],
    resolveNarrowedPath?: (returned: unknown) => string | undefined,
    leaseOptions?: InFlightLeaseOptions,
  ): (() => CallLifecycleLease) | undefined {
    if (initialPaths.length === 0) return undefined;
    const normalizedInitial = initialPaths.map(normalizeInFlightRtdbPath);
    const ttlMs = leaseOptions?.ttlMs ?? DEFAULT_INFLIGHT_LEASE_TTL_MS;
    const readNow = leaseOptions?.now ?? Date.now;
    return () => {
      const nowMs = readNow();
      pruneExpiredWrites(nowMs);
      enforceActiveWriteCap();
      const entry: InFlightWriteEntry = {
        instance,
        paths: normalizedInitial,
        expiresAt: nowMs + ttlMs,
        state: 'active',
      };
      activeWrites.add(entry);
      return {
        onReturn(returned) {
          if (entry.state !== 'active') return;
          const narrowed = resolveNarrowedPath?.(returned);
          if (narrowed !== undefined) {
            entry.paths = [normalizeInFlightRtdbPath(narrowed)];
          }
        },
        release() {
          if (entry.state === 'settled') return;
          if (entry.state === 'active') {
            activeWrites.delete(entry);
          } else if (entry.state === 'overflow-instance') {
            releaseOverflowTaint(entry.instance);
          } else if (entry.state === 'overflow-global' && globalOverflowTaintCount > 0) {
            globalOverflowTaintCount -= 1;
          }
          entry.paths = [];
          entry.state = 'settled';
        },
      };
    };
  }

  return {
    createWriteStarter,
    writeLeaseStarter(input) {
      const plan = planRtdbWritePaths(input);
      if (plan === undefined) return undefined;
      return createWriteStarter(plan.instance, plan.paths, plan.resolveNarrowedPath);
    },
    overlapOf,
    applyDeliveryGuard(instance, deliveryPath, computeBaseDelta, now = Date.now) {
      const overlap = overlapOf(instance, deliveryPath, now);
      if (overlap.kind === 'covered') {
        return { rtdb: [{ kind: 'invalidate', instance, path: normalizeInFlightRtdbPath(deliveryPath) }] };
      }
      const baseDelta = computeBaseDelta();
      if (overlap.kind === 'none') return baseDelta;
      const invalidations: ObservedRtdbSessionOp[] = overlap.paths.map((path) => ({
        kind: 'invalidate',
        instance,
        path,
      }));
      if (baseDelta === undefined) return { rtdb: invalidations };
      const mergedOps = [...(baseDelta.rtdb ?? []), ...invalidations];
      if (baseDelta.skipped !== undefined) {
        return { rtdb: mergedOps, skipped: baseDelta.skipped };
      }
      return { rtdb: mergedOps };
    },
  };
}
