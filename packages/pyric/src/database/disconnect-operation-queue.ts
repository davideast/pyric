import { normalizeNode } from './sandbox/normalize.js';

export type DisconnectOperation<TMetadata extends object = Record<never, never>> =
  | ({ kind: 'set'; path: string; value: unknown; priority?: string | number | null; mergeAfterChildRegistration?: boolean } & TMetadata)
  | ({ kind: 'update'; path: string; values: Record<string, unknown> } & TMetadata)
  | ({ kind: 'remove'; path: string } & TMetadata);

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === '/') return descendant !== '/';
  const prefix = `${ancestor.replace(/\/+$/, '')}/`;
  return descendant !== ancestor && descendant.startsWith(prefix);
}

function isSameOrDescendantPath(ancestor: string, candidate: string): boolean {
  return ancestor === '/' || candidate === ancestor || isAncestorPath(ancestor, candidate);
}

function replacesDescendants<TMetadata extends object>(operation: DisconnectOperation<TMetadata>): boolean {
  return operation.kind === 'set' || operation.kind === 'remove';
}

function isSentinelLeaf(value: object): boolean {
  return Object.hasOwn(value, '.sv') || Object.hasOwn(value, '__rtdbSentinel');
}

function unwrapDotValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '.value')) {
    return (value as Record<string, unknown>)['.value'];
  }
  return value;
}

/**
 * A value with children a cancellation can reach. A server value
 * (`{ ".sv": ... }`) or primitive `.value` wrapper is a leaf, as the SDK holds
 * it, so a path below it names nothing and cancelling that path leaves it whole.
 */
function hasChildren(value: unknown): value is object {
  const unwrapped = unwrapDotValue(value);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  return !isSentinelLeaf(unwrapped);
}

function hasDataContent(value: unknown): boolean {
  const unwrapped = unwrapDotValue(value);
  if (unwrapped === null || unwrapped === undefined) return false;
  if (typeof unwrapped !== 'object') return true;
  if (isSentinelLeaf(unwrapped)) return true;
  return normalizeNode(unwrapped) !== null;
}

function childRecord(value: unknown): Record<string, unknown> | null {
  if (!hasChildren(value)) return null;
  const unwrapped = unwrapDotValue(value) as object;
  if (Array.isArray(unwrapped)) {
    const entries: Array<[string, unknown]> = [];
    for (let index = 0; index < unwrapped.length; index += 1) {
      const entry = unwrapped[index];
      if (entry != null) entries.push([String(index), entry]);
    }
    return Object.fromEntries(entries);
  }
  return unwrapped as Record<string, unknown>;
}

function isPrefixSegments(prefix: string[], full: string[]): boolean {
  return prefix.every((segment, index) => segment === full[index]);
}

function hasNestedPath(value: unknown, segments: string[]): boolean {
  if (segments.length === 0) return false;
  const record = childRecord(value);
  if (record === null) return false;
  for (const [key, entryValue] of Object.entries(record)) {
    if (key.startsWith('.') || entryValue == null) continue;
    const keySegs = pathSegments(key);
    if (keySegs.length === 0) continue;
    if (keySegs.length >= segments.length) {
      if (isPrefixSegments(segments, keySegs)) return true;
      continue;
    }
    const reachesDescendant =
      isPrefixSegments(keySegs, segments) &&
      hasNestedPath(entryValue, segments.slice(keySegs.length));
    if (reachesDescendant) return true;
  }
  return false;
}

function splitsIntoChildMerge<TMetadata extends object>(
  queued: DisconnectOperation<TMetadata>,
  relative: string[],
  cancelledQueuedOperation: boolean,
): queued is ({ kind: 'set'; path: string; value: object; priority?: string | number | null; mergeAfterChildRegistration?: boolean } & TMetadata) {
  if (queued.kind !== 'set' || !hasChildren(queued.value)) return false;
  return cancelledQueuedOperation || hasNestedPath(queued.value, relative);
}

function effectiveSetPriority(
  value: object,
  priority: string | number | null | undefined,
): unknown {
  if (Object.hasOwn(value, '.priority')) {
    return (value as Record<string, unknown>)['.priority'];
  }
  return priority;
}

function ownNodePriority(value: unknown): { present: boolean; priority: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { present: false, priority: null };
  }
  if (!Object.hasOwn(value, '.priority')) {
    return { present: false, priority: null };
  }
  const raw = (value as Record<string, unknown>)['.priority'];
  if (raw === undefined) {
    return { present: false, priority: null };
  }
  return { present: true, priority: structuredClone(raw) };
}

function isPriorityEntryKey(entryKey: string): boolean {
  const segs = pathSegments(entryKey);
  return segs.length > 0 && segs[segs.length - 1] === '.priority';
}

function hasDataUnderPrefix(entries: ReadonlyArray<readonly [string, unknown]>, ownerPrefix: string): boolean {
  const ownerSegs = pathSegments(ownerPrefix);
  for (const [entryKey, entryValue] of entries) {
    if (isPriorityEntryKey(entryKey)) continue;
    if (!hasDataContent(entryValue)) continue;
    if (ownerSegs.length === 0) return true;
    const entrySegs = pathSegments(entryKey);
    if (entrySegs.length >= ownerSegs.length && isPrefixSegments(ownerSegs, entrySegs)) {
      return true;
    }
  }
  return false;
}

function pruneOrphanedPriorities(
  entries: Array<[string, unknown]>,
  owners: ReadonlySet<string>,
): Array<[string, unknown]> {
  if (owners.size === 0) return entries;
  return entries.filter(([entryKey]) => {
    if (!isPriorityEntryKey(entryKey)) return true;
    const ownerPrefix = pathSegments(entryKey).slice(0, -1).join('/');
    if (!owners.has(ownerPrefix)) return true;
    return hasDataUnderPrefix(entries, ownerPrefix);
  });
}

function unfoldWithoutNestedPath(
  prefix: string,
  value: unknown,
  segments: string[],
  unfoldedPriorityOwners: Set<string>,
  includeRootOwnPriority: boolean,
): Array<[string, unknown]> {
  if (segments.length === 0) return [];
  const record = childRecord(value);
  if (record === null) return [[prefix, structuredClone(value)]];
  const entries = Object.entries(record).flatMap(([childKey, childValue]): Array<[string, unknown]> => {
    if (childKey.startsWith('.') || childValue == null) return [];
    const keySegs = pathSegments(childKey);
    if (keySegs.length === 0) return [];
    const joinedKey = keySegs.join('/');
    const childPrefix = prefix ? `${prefix}/${joinedKey}` : joinedKey;
    if (keySegs.length >= segments.length) {
      if (isPrefixSegments(segments, keySegs)) return [];
      return [[childPrefix, structuredClone(childValue)]];
    }
    if (!isPrefixSegments(keySegs, segments)) {
      return [[childPrefix, structuredClone(childValue)]];
    }
    return unfoldWithoutNestedPath(
      childPrefix,
      childValue,
      segments.slice(keySegs.length),
      unfoldedPriorityOwners,
      false,
    );
  });
  const ownPriority = ownNodePriority(value);
  if (ownPriority.present) {
    if (prefix !== '') {
      unfoldedPriorityOwners.add(prefix);
      if (hasDataUnderPrefix(entries, prefix)) {
        entries.push([`${prefix}/.priority`, ownPriority.priority]);
      }
    } else if (includeRootOwnPriority) {
      const cancelsRootPriority = segments.length === 1 && segments[0] === '.priority';
      if (!cancelsRootPriority) {
        entries.push(['.priority', ownPriority.priority]);
      }
    }
  }
  return entries;
}

/** Pure Firebase onDisconnect registration/coalescing state, shared by both transports. */
export class DisconnectOperationQueue<TMetadata extends object = Record<never, never>> {
  private readonly operations = new Map<string, DisconnectOperation<TMetadata>>();
  private readonly unfoldedPriorityOwners = new Map<string, Set<string>>();

  set(operation: DisconnectOperation<TMetadata>): void {
    // The SDK registers nothing for an empty update, so a write queued at the
    // same path stays queued.
    if (operation.kind === 'update' && Object.keys(operation.values).length === 0) return;
    if (replacesDescendants(operation)) {
      for (const queuedPath of [...this.operations.keys()]) {
        if (isAncestorPath(operation.path, queuedPath)) {
          this.operations.delete(queuedPath);
          this.unfoldedPriorityOwners.delete(queuedPath);
        }
      }
    }
    this.unfoldedPriorityOwners.delete(operation.path);
    this.operations.set(operation.path, structuredClone(operation));
  }

  cancel(path: string): void {
    let cancelledQueuedOperation = false;
    for (const queuedPath of [...this.operations.keys()]) {
      if (isSameOrDescendantPath(path, queuedPath)) {
        this.operations.delete(queuedPath);
        this.unfoldedPriorityOwners.delete(queuedPath);
        cancelledQueuedOperation = true;
      }
    }
    for (const queuedPath of [...this.operations.keys()]) {
      if (!isAncestorPath(queuedPath, path)) continue;
      const queued = this.operations.get(queuedPath)!;
      const relative = pathSegments(path).slice(pathSegments(queuedPath).length);
      if (splitsIntoChildMerge(queued, relative, cancelledQueuedOperation)) {
        const owners = new Set<string>();
        const entries = unfoldWithoutNestedPath('', queued.value, relative, owners, false);
        if (!hasDataUnderPrefix(entries, '')) {
          this.operations.delete(queuedPath);
          this.unfoldedPriorityOwners.delete(queuedPath);
          continue;
        }
        const priority = effectiveSetPriority(queued.value, queued.priority);
        if (priority !== undefined) {
          entries.push(['.priority', structuredClone(priority)]);
          owners.add('');
        }
        const pruned = pruneOrphanedPriorities(entries, owners);
        const {
          kind: _kind,
          value: _value,
          priority: _priority,
          mergeAfterChildRegistration: _merge,
          ...metadata
        } = queued;
        const mergedOperation = {
          ...metadata,
          kind: 'update' as const,
          path: queued.path,
          values: Object.fromEntries(pruned),
        } as DisconnectOperation<TMetadata>;
        this.operations.set(queuedPath, mergedOperation);
        this.unfoldedPriorityOwners.set(queuedPath, owners);
      } else if (queued.kind === 'update') {
        const canReachChild = cancelledQueuedOperation || hasNestedPath(queued.values, relative);
        if (!canReachChild) continue;
        const owners = new Set(this.unfoldedPriorityOwners.get(queuedPath) ?? []);
        const unfolded = unfoldWithoutNestedPath('', queued.values, relative, owners, true);
        const pruned = pruneOrphanedPriorities(unfolded, owners);
        if (pruned.length === 0) {
          this.operations.delete(queuedPath);
          this.unfoldedPriorityOwners.delete(queuedPath);
          continue;
        }
        this.operations.set(queuedPath, { ...queued, values: Object.fromEntries(pruned) });
        this.unfoldedPriorityOwners.set(queuedPath, owners);
      }
    }
  }

  takeAll(): DisconnectOperation<TMetadata>[] {
    const queued = [...this.operations.values()];
    this.operations.clear();
    this.unfoldedPriorityOwners.clear();
    return queued;
  }

  clear(): void {
    this.operations.clear();
    this.unfoldedPriorityOwners.clear();
  }
}
