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

/**
 * A value with children a cancellation can reach. A server value
 * (`{ ".sv": ... }`) is a leaf, as the SDK holds it, so a path below it names
 * nothing and cancelling that path leaves it whole.
 */
function hasChildren(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Object.hasOwn(value, '.sv');
}

function childRecord(value: unknown): Record<string, unknown> | null {
  if (!hasChildren(value)) return null;
  if (Array.isArray(value)) {
    const entries: Array<[string, unknown]> = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry != null) entries.push([String(index), entry]);
    }
    return Object.fromEntries(entries);
  }
  return value as Record<string, unknown>;
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
): string | number | null | undefined {
  if (Object.hasOwn(value, '.priority')) {
    return (value as Record<string, unknown>)['.priority'] as string | number | null;
  }
  return priority;
}

function unfoldWithoutNestedPath(
  prefix: string,
  value: unknown,
  segments: string[],
): Array<[string, unknown]> {
  if (segments.length === 0) return [];
  const record = childRecord(value);
  if (record === null) return [[prefix, structuredClone(value)]];
  return Object.entries(record).flatMap(([childKey, childValue]) => {
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
    return unfoldWithoutNestedPath(childPrefix, childValue, segments.slice(keySegs.length));
  });
}

/** Pure Firebase onDisconnect registration/coalescing state, shared by both transports. */
export class DisconnectOperationQueue<TMetadata extends object = Record<never, never>> {
  private readonly operations = new Map<string, DisconnectOperation<TMetadata>>();

  set(operation: DisconnectOperation<TMetadata>): void {
    // The SDK registers nothing for an empty update, so a write queued at the
    // same path stays queued.
    if (operation.kind === 'update' && Object.keys(operation.values).length === 0) return;
    if (replacesDescendants(operation)) {
      for (const queuedPath of [...this.operations.keys()]) {
        if (isAncestorPath(operation.path, queuedPath)) {
          this.operations.delete(queuedPath);
        }
      }
    }
    this.operations.set(operation.path, structuredClone(operation));
  }

  cancel(path: string): void {
    let cancelledQueuedOperation = false;
    for (const queuedPath of [...this.operations.keys()]) {
      if (isSameOrDescendantPath(path, queuedPath)) {
        this.operations.delete(queuedPath);
        cancelledQueuedOperation = true;
      }
    }
    for (const queuedPath of [...this.operations.keys()]) {
      if (!isAncestorPath(queuedPath, path)) continue;
      const queued = this.operations.get(queuedPath)!;
      const relative = pathSegments(path).slice(pathSegments(queuedPath).length);
      if (splitsIntoChildMerge(queued, relative, cancelledQueuedOperation)) {
        const priority = effectiveSetPriority(queued.value, queued.priority);
        const splitOperation: DisconnectOperation<TMetadata> = {
          ...queued,
          value: Object.fromEntries(unfoldWithoutNestedPath('', queued.value, relative)),
          mergeAfterChildRegistration: true,
        };
        if (priority !== undefined) splitOperation.priority = priority;
        this.operations.set(queuedPath, splitOperation);
      } else if (queued.kind === 'update') {
        const canReachChild = cancelledQueuedOperation || hasNestedPath(queued.values, relative);
        if (!canReachChild) continue;
        const kept = Object.fromEntries(unfoldWithoutNestedPath('', queued.values, relative));
        this.operations.set(queuedPath, { ...queued, values: kept });
      }
    }
  }

  takeAll(): DisconnectOperation<TMetadata>[] {
    const queued = [...this.operations.values()];
    this.operations.clear();
    return queued;
  }

  clear(): void {
    this.operations.clear();
  }
}
