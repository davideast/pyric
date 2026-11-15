import { normalizeNode } from './sandbox/normalize.js';

type DisconnectSetOperation<TMetadata extends object = Record<never, never>> =
  { kind: 'set'; path: string; value: unknown; priority?: string | number | null; mergeAfterChildRegistration?: boolean } & TMetadata;

type DisconnectUpdateOperation<TMetadata extends object = Record<never, never>> =
  { kind: 'update'; path: string; values: Record<string, unknown> } & TMetadata;

type DisconnectRemoveOperation<TMetadata extends object = Record<never, never>> =
  { kind: 'remove'; path: string } & TMetadata;

export type DisconnectOperation<TMetadata extends object = Record<never, never>> =
  | DisconnectSetOperation<TMetadata>
  | DisconnectUpdateOperation<TMetadata>
  | DisconnectRemoveOperation<TMetadata>;

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

function joinPath(basePath: string, segments: readonly string[]): string {
  const trimmed = basePath.replace(/\/+$/, '');
  const suffix = segments.join('/');
  if (trimmed === '') return `/${suffix}`;
  return `${trimmed}/${suffix}`;
}

function isScalarPriority(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
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

function applyInlinePriority(value: unknown, priority: unknown): unknown {
  if (!hasDataContent(value)) return null;
  if (priority === null || priority === undefined) {
    const isPlainRecord = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isPlainRecord || !Object.hasOwn(value, '.priority')) {
      return structuredClone(value);
    }
    const copy = structuredClone(value) as Record<string, unknown>;
    delete copy['.priority'];
    if (Object.hasOwn(copy, '.value') && Object.keys(copy).length === 1) {
      return copy['.value'];
    }
    return copy;
  }
  const clonedPriority = structuredClone(priority);
  if (hasChildren(value)) {
    const next = structuredClone(childRecord(value) ?? {}) as Record<string, unknown>;
    next['.priority'] = clonedPriority;
    return next;
  }
  return { '.value': structuredClone(unwrapDotValue(value)), '.priority': clonedPriority };
}

function buildNestedValue(segments: readonly string[], leafValue: unknown): unknown {
  if (segments.length === 0) {
    if (!hasDataContent(leafValue)) return null;
    return structuredClone(leafValue);
  }
  if (!hasDataContent(leafValue)) return null;
  const [head, ...rest] = segments;
  if (head === undefined || head === '.priority') return null;
  const child = buildNestedValue(rest, leafValue);
  if (!hasDataContent(child)) return null;
  return { [head]: child };
}

function overlayNodeValue(current: unknown, segments: readonly string[], replacement: unknown): unknown {
  if (segments.length === 0) {
    if (!hasDataContent(replacement)) return null;
    return structuredClone(replacement);
  }
  const [head, ...rest] = segments;
  if (head === undefined) return structuredClone(current);
  if (head === '.priority') {
    return applyInlinePriority(current, replacement);
  }
  const replacementHasData = hasDataContent(replacement);
  if (!hasDataContent(current)) {
    if (!replacementHasData) return null;
    return buildNestedValue(segments, replacement);
  }
  const record = childRecord(current);
  if (record === null) {
    if (!replacementHasData) return structuredClone(current);
    const created = buildNestedValue(segments, replacement);
    const ownPriority = ownNodePriority(current);
    if (ownPriority.present) {
      return applyInlinePriority(created, ownPriority.priority);
    }
    return created;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (key.startsWith('.') || !hasDataContent(entryValue)) continue;
    next[key] = structuredClone(entryValue);
  }
  let existingChild: unknown = null;
  if (Object.hasOwn(next, head)) {
    existingChild = next[head];
  }
  const updatedChild = overlayNodeValue(existingChild, rest, replacement);
  if (hasDataContent(updatedChild)) {
    next[head] = updatedChild;
  } else {
    delete next[head];
  }
  if (Object.keys(next).length === 0) return null;
  const ownPriority = ownNodePriority(current);
  if (ownPriority.present) {
    next['.priority'] = ownPriority.priority;
  }
  return next;
}

function overlaySetValues(
  baseValue: unknown,
  basePriority: string | number | null | undefined,
  values: Record<string, unknown>,
): { value: unknown; priority: string | number | null | undefined } {
  let nextValue = structuredClone(baseValue);
  let nextPriority: string | number | null | undefined = undefined;
  if (hasDataContent(nextValue)) {
    nextPriority = basePriority;
  }
  let hasRootPriorityUpdate = false;
  let rootPriorityValue: unknown = null;
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const segs = pathSegments(rawKey);
    if (segs.length === 0) continue;
    if (segs.length === 1 && segs[0] === '.priority') {
      hasRootPriorityUpdate = true;
      rootPriorityValue = rawValue;
      continue;
    }
    nextValue = overlayNodeValue(nextValue, segs, rawValue);
  }
  if (!hasDataContent(nextValue)) {
    return { value: null, priority: undefined };
  }
  if (hasRootPriorityUpdate) {
    if (rootPriorityValue === null || rootPriorityValue === undefined) {
      nextPriority = undefined;
      nextValue = applyInlinePriority(nextValue, null);
    } else if (isScalarPriority(rootPriorityValue)) {
      nextPriority = rootPriorityValue;
      nextValue = applyInlinePriority(nextValue, null);
    } else {
      nextPriority = undefined;
      nextValue = applyInlinePriority(nextValue, rootPriorityValue);
    }
  }
  return { value: nextValue, priority: nextPriority };
}

function mergeUpdateValues(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  priorityOwners?: Set<string>,
): Record<string, unknown> {
  const merged = new Map<string, { segments: string[]; value: unknown }>();
  for (const [rawKey, rawValue] of Object.entries(existing)) {
    const segments = pathSegments(rawKey);
    if (segments.length === 0) continue;
    merged.set(segments.join('/'), { segments, value: structuredClone(rawValue) });
  }
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const inSegs = pathSegments(rawKey);
    if (inSegs.length === 0) continue;
    const inKey = inSegs.join('/');
    if (merged.has(inKey)) {
      if (priorityOwners !== undefined && isPriorityEntryKey(inKey)) {
        priorityOwners.delete(inSegs.slice(0, -1).join('/'));
      }
      merged.set(inKey, { segments: inSegs, value: structuredClone(rawValue) });
      continue;
    }
    let overlaidAncestor = false;
    for (const [existingKey, entry] of merged.entries()) {
      const isExistingAncestor =
        entry.segments.length < inSegs.length && isPrefixSegments(entry.segments, inSegs);
      if (!isExistingAncestor) continue;
      const relative = inSegs.slice(entry.segments.length);
      const overlaid = overlayNodeValue(entry.value, relative, rawValue);
      merged.set(existingKey, { segments: entry.segments, value: overlaid });
      overlaidAncestor = true;
      break;
    }
    if (overlaidAncestor) continue;
    for (const [existingKey, entry] of [...merged.entries()]) {
      const isExistingDescendant =
        inSegs.length < entry.segments.length && isPrefixSegments(inSegs, entry.segments);
      if (isExistingDescendant) {
        merged.delete(existingKey);
      }
    }
    if (priorityOwners !== undefined) {
      for (const owner of [...priorityOwners]) {
        const ownerSegs = pathSegments(owner);
        if (ownerSegs.length >= inSegs.length && isPrefixSegments(inSegs, ownerSegs)) {
          priorityOwners.delete(owner);
        }
      }
    }
    merged.set(inKey, { segments: inSegs, value: structuredClone(rawValue) });
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of merged.entries()) {
    result[key] = entry.value;
  }
  return result;
}

/** Pure Firebase onDisconnect registration/coalescing state, shared by both transports. */
export class DisconnectOperationQueue<TMetadata extends object = Record<never, never>> {
  private readonly operations = new Map<string, DisconnectOperation<TMetadata>>();
  private readonly unfoldedPriorityOwners = new Map<string, Set<string>>();

  get isEmpty(): boolean {
    return this.operations.size === 0;
  }

  private applyUpdateAtPath(
    targetPath: string,
    values: Record<string, unknown>,
    incoming: DisconnectUpdateOperation<TMetadata>,
  ): void {
    const queued = this.operations.get(targetPath);
    if (queued === undefined) {
      this.unfoldedPriorityOwners.delete(targetPath);
      this.operations.set(targetPath, structuredClone({ ...incoming, path: targetPath, values }));
      return;
    }
    if (queued.kind === 'update') {
      const owners = this.unfoldedPriorityOwners.get(targetPath);
      const mergedValues = mergeUpdateValues(queued.values, values, owners);
      this.operations.set(targetPath, structuredClone({ ...queued, values: mergedValues }));
      return;
    }
    if (queued.kind === 'set') {
      const overlaid = overlaySetValues(queued.value, queued.priority, values);
      const nextSet: DisconnectSetOperation<TMetadata> = {
        ...queued,
        value: overlaid.value,
      };
      if (overlaid.priority !== undefined) {
        nextSet.priority = overlaid.priority;
      } else {
        delete nextSet.priority;
      }
      this.unfoldedPriorityOwners.delete(targetPath);
      this.operations.set(targetPath, nextSet);
      return;
    }
    const overlaid = overlaySetValues(null, undefined, values);
    if (!hasDataContent(overlaid.value)) return;
    const { kind: _kind, path: _path, ...metadata } = queued;
    const nextSet = {
      ...metadata,
      kind: 'set' as const,
      path: targetPath,
      value: overlaid.value,
    } as DisconnectSetOperation<TMetadata>;
    if (overlaid.priority !== undefined) {
      nextSet.priority = overlaid.priority;
    }
    this.unfoldedPriorityOwners.delete(targetPath);
    this.operations.set(targetPath, nextSet);
  }

  set(operation: DisconnectOperation<TMetadata>): void {
    // The SDK registers nothing for an empty update, so a write queued at the
    // same path stays queued.
    if (operation.kind === 'update' && Object.keys(operation.values).length === 0) return;
    if (operation.kind !== 'update') {
      for (const queuedPath of [...this.operations.keys()]) {
        if (isAncestorPath(operation.path, queuedPath)) {
          this.operations.delete(queuedPath);
          this.unfoldedPriorityOwners.delete(queuedPath);
        }
      }
      this.unfoldedPriorityOwners.delete(operation.path);
      this.operations.delete(operation.path);
      this.operations.set(operation.path, structuredClone(operation));
      return;
    }
    const remainingValues: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(operation.values)) {
      const segs = pathSegments(rawKey);
      if (segs.length === 0) continue;
      const targetPath = joinPath(operation.path, segs);
      for (const queuedPath of [...this.operations.keys()]) {
        if (!isAncestorPath(operation.path, queuedPath)) continue;
        if (isSameOrDescendantPath(targetPath, queuedPath)) {
          this.operations.delete(queuedPath);
          this.unfoldedPriorityOwners.delete(queuedPath);
        }
      }
      let deepestDescendant: string | null = null;
      let deepestDepth = -1;
      for (const queuedPath of this.operations.keys()) {
        if (!isAncestorPath(operation.path, queuedPath)) continue;
        if (!isAncestorPath(queuedPath, targetPath)) continue;
        const depth = pathSegments(queuedPath).length;
        if (depth > deepestDepth) {
          deepestDepth = depth;
          deepestDescendant = queuedPath;
        }
      }
      if (deepestDescendant !== null) {
        const tailKey = pathSegments(targetPath).slice(deepestDepth).join('/');
        this.applyUpdateAtPath(deepestDescendant, { [tailKey]: rawValue }, operation);
        continue;
      }
      remainingValues[segs.join('/')] = rawValue;
    }
    if (Object.keys(remainingValues).length === 0) return;
    this.applyUpdateAtPath(operation.path, remainingValues, operation);
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
