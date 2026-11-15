import {
  applyInlinePriority,
  effectiveSetPriority,
  hasChildren,
  hasDataContent,
  hasDataUnderPrefix,
  hasNestedPath,
  isAncestorPath,
  isSameOrDescendantPath,
  joinPath,
  mergeUpdateValues,
  overlaySetValues,
  pathSegments,
  pruneOrphanedPriorities,
  unfoldWithoutNestedPath,
} from './disconnect-operation-overlay.js';

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

function splitsIntoChildMerge<TMetadata extends object>(
  queued: DisconnectOperation<TMetadata>,
  relative: string[],
  cancelledQueuedOperation: boolean,
): queued is ({ kind: 'set'; path: string; value: object; priority?: string | number | null; mergeAfterChildRegistration?: boolean } & TMetadata) {
  if (queued.kind !== 'set' || !hasChildren(queued.value)) return false;
  return cancelledQueuedOperation || hasNestedPath(queued.value, relative);
}

function replacementValueForOperation<TMetadata extends object>(
  operation: DisconnectSetOperation<TMetadata> | DisconnectRemoveOperation<TMetadata>,
): unknown {
  if (operation.kind === 'remove') return null;
  if (operation.priority !== undefined) {
    return applyInlinePriority(operation.value, operation.priority);
  }
  return structuredClone(operation.value);
}

/** Pure Firebase onDisconnect registration/coalescing state, shared by both transports. */
export class DisconnectOperationQueue<TMetadata extends object = Record<never, never>> {
  private readonly operations = new Map<string, DisconnectOperation<TMetadata>>();
  private readonly unfoldedPriorityOwners = new Map<string, Set<string>>();

  get isEmpty(): boolean {
    return this.operations.size === 0;
  }

  private syncUnfoldedPriorityOwners(
    queuedPath: string,
    entries: ReadonlyArray<[string, unknown]>,
    owners: Set<string>,
  ): void {
    const remainingKeys = new Set<string>();
    for (const [entryKey] of entries) {
      remainingKeys.add(entryKey);
    }
    for (const owner of [...owners]) {
      let priorityKey = '.priority';
      if (owner !== '') {
        priorityKey = `${owner}/.priority`;
      }
      if (!remainingKeys.has(priorityKey)) {
        owners.delete(owner);
      }
    }
    if (owners.size === 0) {
      this.unfoldedPriorityOwners.delete(queuedPath);
      return;
    }
    this.unfoldedPriorityOwners.set(queuedPath, owners);
  }

  private findCoveringOperation(targetPath: string, excludePath: string): string | null {
    for (const [queuedPath, queued] of this.operations.entries()) {
      if (queuedPath === excludePath) continue;
      if (queued.kind !== 'update') {
        if (isAncestorPath(queuedPath, targetPath)) return queuedPath;
        continue;
      }
      for (const rawKey of Object.keys(queued.values)) {
        const segs = pathSegments(rawKey);
        if (segs.length === 0) continue;
        if (isAncestorPath(joinPath(queuedPath, segs), targetPath)) {
          return queuedPath;
        }
      }
      const owners = this.unfoldedPriorityOwners.get(queuedPath);
      if (owners !== undefined) {
        for (const owner of owners) {
          let ownerPath = queuedPath;
          if (owner !== '') {
            ownerPath = joinPath(queuedPath, pathSegments(owner));
          }
          if (isAncestorPath(ownerPath, targetPath)) {
            return queuedPath;
          }
        }
      }
    }
    return null;
  }

  private pruneCoveredByPath(targetPath: string, excludePath: string): void {
    for (const [queuedPath, queued] of [...this.operations.entries()]) {
      if (queuedPath === excludePath) continue;
      if (isSameOrDescendantPath(targetPath, queuedPath)) {
        this.operations.delete(queuedPath);
        this.unfoldedPriorityOwners.delete(queuedPath);
        continue;
      }
      if (queued.kind !== 'update') continue;
      const retained: Array<[string, unknown]> = [];
      let removedAny = false;
      for (const [rawKey, rawValue] of Object.entries(queued.values)) {
        const segs = pathSegments(rawKey);
        if (segs.length === 0) continue;
        if (isSameOrDescendantPath(targetPath, joinPath(queuedPath, segs))) {
          removedAny = true;
          continue;
        }
        retained.push([rawKey, rawValue]);
      }
      if (!removedAny) continue;
      const owners = this.unfoldedPriorityOwners.get(queuedPath);
      let pruned = retained;
      if (owners !== undefined) {
        pruned = pruneOrphanedPriorities(retained, owners);
      }
      if (pruned.length === 0) {
        this.operations.delete(queuedPath);
        this.unfoldedPriorityOwners.delete(queuedPath);
        continue;
      }
      this.operations.set(queuedPath, { ...queued, values: Object.fromEntries(pruned) });
      if (owners !== undefined) {
        this.syncUnfoldedPriorityOwners(queuedPath, pruned, owners);
      }
    }
  }

  private mergeIntoQueued(targetPath: string, values: Record<string, unknown>): boolean {
    const queued = this.operations.get(targetPath);
    if (queued === undefined) return false;
    if (queued.kind === 'update') {
      const owners = this.unfoldedPriorityOwners.get(targetPath);
      const mergedValues = mergeUpdateValues(queued.values, values, owners);
      if (owners !== undefined && owners.size === 0) {
        this.unfoldedPriorityOwners.delete(targetPath);
      }
      this.operations.set(targetPath, structuredClone({ ...queued, values: mergedValues }));
      return true;
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
      return true;
    }
    const overlaid = overlaySetValues(null, undefined, values);
    if (!hasDataContent(overlaid.value)) return true;
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
    return true;
  }

  private applyUpdateAtPath(
    targetPath: string,
    values: Record<string, unknown>,
    incoming: DisconnectUpdateOperation<TMetadata>,
  ): void {
    if (this.mergeIntoQueued(targetPath, values)) return;
    this.unfoldedPriorityOwners.delete(targetPath);
    this.operations.set(targetPath, structuredClone({ ...incoming, path: targetPath, values }));
  }

  set(operation: DisconnectOperation<TMetadata>): void {
    // The SDK registers nothing for an empty update, so a write queued at the
    // same path stays queued.
    if (operation.kind === 'update' && Object.keys(operation.values).length === 0) return;
    if (operation.kind !== 'update') {
      const coveringPath = this.findCoveringOperation(operation.path, operation.path);
      if (coveringPath !== null) {
        const relKey = pathSegments(operation.path).slice(pathSegments(coveringPath).length).join('/');
        this.mergeIntoQueued(coveringPath, { [relKey]: replacementValueForOperation(operation) });
        return;
      }
      this.pruneCoveredByPath(operation.path, operation.path);
      this.unfoldedPriorityOwners.delete(operation.path);
      this.operations.delete(operation.path);
      this.operations.set(operation.path, structuredClone(operation));
      return;
    }
    const foldedBatches = new Map<string, Record<string, unknown>>();
    const remainingValues: Record<string, unknown> = {};
    const remainingTargets: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(operation.values)) {
      const segs = pathSegments(rawKey);
      if (segs.length === 0) continue;
      const targetPath = joinPath(operation.path, segs);
      const coveringPath = this.findCoveringOperation(targetPath, operation.path);
      if (coveringPath !== null) {
        const relKey = pathSegments(targetPath).slice(pathSegments(coveringPath).length).join('/');
        let batch = foldedBatches.get(coveringPath);
        if (batch === undefined) {
          batch = {};
          foldedBatches.set(coveringPath, batch);
        }
        batch[relKey] = rawValue;
        continue;
      }
      remainingTargets.push(targetPath);
      remainingValues[segs.join('/')] = rawValue;
    }
    for (const targetPath of remainingTargets) {
      this.pruneCoveredByPath(targetPath, operation.path);
    }
    for (const [coveringPath, batch] of foldedBatches.entries()) {
      this.mergeIntoQueued(coveringPath, batch);
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
        this.syncUnfoldedPriorityOwners(queuedPath, pruned, owners);
      } else if (queued.kind === 'update') {
        const canReachChild = cancelledQueuedOperation || hasNestedPath(queued.values, relative);
        if (!canReachChild) continue;
        const existingOwners = this.unfoldedPriorityOwners.get(queuedPath);
        const owners = new Set(existingOwners);
        const unfolded = unfoldWithoutNestedPath('', queued.values, relative, owners, true);
        const pruned = pruneOrphanedPriorities(unfolded, owners);
        if (pruned.length === 0) {
          this.operations.delete(queuedPath);
          this.unfoldedPriorityOwners.delete(queuedPath);
          continue;
        }
        this.operations.set(queuedPath, { ...queued, values: Object.fromEntries(pruned) });
        this.syncUnfoldedPriorityOwners(queuedPath, pruned, owners);
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
