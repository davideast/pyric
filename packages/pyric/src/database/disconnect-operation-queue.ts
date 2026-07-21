export type DisconnectOperation<TMetadata extends object = Record<never, never>> =
  | ({ kind: 'set'; path: string; value: unknown; priority?: string | number | null; mergeAfterChildRegistration?: boolean } & TMetadata)
  | ({ kind: 'update'; path: string; values: Record<string, unknown> } & TMetadata)
  | ({ kind: 'remove'; path: string } & TMetadata);

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  const prefix = ancestor === '/' ? '/' : `${ancestor.replace(/\/+$/, '')}/`;
  return descendant !== ancestor && descendant.startsWith(prefix);
}

function withoutNestedPath(value: unknown, segments: string[]): unknown {
  if (segments.length === 0 || value === null || typeof value !== 'object') return value;
  const clone = (Array.isArray(value)
    ? Object.fromEntries(value.flatMap((entry, index) => entry == null ? [] : [[String(index), structuredClone(entry)]]))
    : structuredClone(value)) as Record<string, unknown>;
  const [head, ...tail] = segments;
  if (!(head! in clone)) return clone;
  if (tail.length === 0) delete clone[head!];
  else {
    const nested = withoutNestedPath(clone[head!], tail);
    if (nested && typeof nested === 'object' && Object.keys(nested).length === 0) delete clone[head!];
    else clone[head!] = nested;
  }
  return clone;
}

/** Pure Firebase onDisconnect registration/coalescing state, shared by both transports. */
export class DisconnectOperationQueue<TMetadata extends object = Record<never, never>> {
  private readonly operations = new Map<string, DisconnectOperation<TMetadata>>();

  set(operation: DisconnectOperation<TMetadata>): void {
    this.operations.set(operation.path, structuredClone(operation));
  }

  cancel(path: string): void {
    const prefix = path === '/' ? '/' : `${path.replace(/\/+$/, '')}/`;
    for (const queuedPath of [...this.operations.keys()]) {
      if (path === '/' || queuedPath === path || queuedPath.startsWith(prefix)) {
        this.operations.delete(queuedPath);
        continue;
      }
      if (!isAncestorPath(queuedPath, path)) continue;
      const queued = this.operations.get(queuedPath)!;
      const relative = pathSegments(path).slice(pathSegments(queuedPath).length);
      if (queued.kind === 'set' && queued.value !== null && typeof queued.value === 'object') {
        this.operations.set(queuedPath, {
          ...queued,
          value: withoutNestedPath(queued.value, relative),
          mergeAfterChildRegistration: true,
        });
      } else if (queued.kind === 'update') {
        const kept = Object.fromEntries(Object.entries(queued.values).flatMap(([key, value]) => {
          const updatePath = `${queuedPath.replace(/\/+$/, '')}/${key}`;
          if (updatePath === path || isAncestorPath(path, updatePath)) return [];
          if (!isAncestorPath(updatePath, path)) return [[key, value]];
          const nested = pathSegments(path).slice(pathSegments(updatePath).length);
          const pruned = withoutNestedPath(value, nested);
          if (pruned && typeof pruned === 'object' && Object.keys(pruned).length === 0) return [];
          return [[key, pruned]];
        }));
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
