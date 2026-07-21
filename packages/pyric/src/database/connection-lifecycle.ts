import type { AuthState } from 'pyric/sandbox';
import type { RtdbBackend } from './sandbox/backend.js';
import type { JsonValue } from './sandbox/data-tree.js';

export type DisconnectOperation =
  | { kind: 'set'; path: string; value: unknown; priority?: string | number | null; mergeAfterChildRegistration?: boolean }
  | { kind: 'update'; path: string; values: Record<string, unknown> }
  | { kind: 'remove'; path: string };

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

export class RtdbConnectionLifecycle {
  private readonly operations = new Map<string, DisconnectOperation>();
  private draining: Promise<void> | null = null;
  private online = true;

  constructor(
    private readonly backend: RtdbBackend,
    private readonly auth: () => AuthState,
    private readonly admin: boolean,
  ) {}

  register(operation: DisconnectOperation): Promise<void> {
    try {
      if (!this.admin) {
        if (operation.kind === 'update') {
          this.backend.validateUpdate(this.auth(), operation.path, operation.values);
        } else {
          this.backend.validateSet(
            this.auth(),
            operation.path,
            operation.kind === 'remove' ? null : operation.value,
          );
        }
      }
      this.operations.set(operation.path, structuredClone(operation));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  cancel(path: string): Promise<void> {
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
    return Promise.resolve();
  }

  clear(): void {
    this.operations.clear();
    this.online = true;
  }

  goOffline(): void {
    if (!this.online) return;
    this.online = false;
    void this.drain().catch(() => undefined);
  }

  goOnline(): void {
    this.online = true;
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const queued = [...this.operations.values()];
    this.operations.clear();
    this.draining = (async () => {
      const failures: unknown[] = [];
      for (const operation of queued) {
        try {
          if (operation.kind === 'update') {
            if (this.admin) {
              this.backend.adminUpdate(operation.path, operation.values as Record<string, JsonValue>);
            } else {
              this.backend.update(this.auth(), operation.path, operation.values as Record<string, JsonValue>);
            }
          } else {
            const value = operation.kind === 'remove' ? null : operation.value;
            if (
              operation.kind === 'set' &&
              operation.mergeAfterChildRegistration &&
              value !== null && typeof value === 'object' && !Array.isArray(value)
            ) {
              if (this.admin) {
                this.backend.adminUpdate(operation.path, value as Record<string, JsonValue>);
              } else {
                this.backend.update(this.auth(), operation.path, value as Record<string, JsonValue>);
              }
              continue;
            }
            if (this.admin) {
              this.backend.adminSet(operation.path, value as JsonValue);
            } else {
              this.backend.set(this.auth(), operation.path, value as JsonValue);
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Multiple onDisconnect operations failed');
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }
}
