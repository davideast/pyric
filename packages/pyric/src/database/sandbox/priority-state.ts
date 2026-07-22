import { joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { Priority } from './query.js';

export class PriorityState {
  private readonly values = new Map<string, Exclude<Priority, null>>();

  get(path: string): Priority {
    return this.values.get(joinPath(pathSegments(path))) ?? null;
  }

  forChild(path: string): (key: string) => Priority {
    const base = pathSegments(path);
    return (key) => this.get(joinPath([...base, key]));
  }

  clear(): void {
    this.values.clear();
  }

  clearAtOrBelow(path: string): void {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    for (const key of this.values.keys()) {
      if (key === canonical || key.startsWith(prefix)) this.values.delete(key);
    }
  }

  replace(path: string, priority: Priority): void {
    this.clearAtOrBelow(path);
    if (priority !== null) this.values.set(joinPath(pathSegments(path)), priority);
  }

  set(path: string, priority: Priority): void {
    const canonical = joinPath(pathSegments(path));
    if (priority === null) this.values.delete(canonical);
    else this.values.set(canonical, priority);
  }

  stateAtOrBelow(path: string): string {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    return JSON.stringify([...this.values]
      .filter(([key]) => key === canonical || key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)));
  }

  applyUpdate(writes: Array<{ path: string; value: JsonValue }>): void {
    for (const write of writes) {
      const priority = this.get(write.path);
      this.clearAtOrBelow(write.path);
      if (write.value !== null && priority !== null) {
        this.values.set(joinPath(pathSegments(write.path)), priority);
      }
    }
  }

  entries(): IterableIterator<[string, Exclude<Priority, null>]> {
    return this.values.entries();
  }

  restore(values: Record<string, Exclude<Priority, null>>): void {
    this.values.clear();
    for (const [path, priority] of Object.entries(values)) {
      this.values.set(joinPath(pathSegments(path)), priority);
    }
  }
}

export function validatePriority(priority: Priority): void {
  if (
    priority !== null
    && typeof priority !== 'string'
    && (typeof priority !== 'number' || !Number.isFinite(priority))
  ) {
    throw new Error('priority must be a valid Firebase priority (string, finite number, or null)');
  }
}
