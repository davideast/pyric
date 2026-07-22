import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import type { JsonValue } from './data-tree.js';
import type { Priority } from './query.js';
import type { ValueListeners } from './value-listeners.js';

function decode(root: JsonValue): {
  data: JsonValue;
  priorities: Record<string, Exclude<Priority, null>>;
} {
  if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
    const candidate = root as Record<string, JsonValue>;
    const encoded = candidate.priorities;
    if (candidate['.pyricRtdbPersistence'] === 1 && 'data' in candidate
      && encoded !== null && typeof encoded === 'object' && !Array.isArray(encoded)) {
      const priorities: Record<string, Exclude<Priority, null>> = {};
      for (const [path, priority] of Object.entries(encoded)) {
        if (typeof priority === 'string' || (typeof priority === 'number' && Number.isFinite(priority))) {
          priorities[path] = priority;
        }
      }
      return { data: candidate.data ?? null, priorities };
    }
  }
  return { data: root, priorities: {} };
}

export class PersistenceState {
  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
  ) {}

  exportTree(): JsonValue {
    return this.state.tree.snapshot();
  }

  exportState(): JsonValue {
    return {
      '.pyricRtdbPersistence': 1,
      data: this.state.tree.snapshot(),
      priorities: Object.fromEntries(this.state.priorities.entries()),
    } as JsonValue;
  }

  restore(root: JsonValue): void {
    const priors = this.children.snapshotParents();
    const persisted = decode(root);
    this.state.tree.restore(persisted.data ?? {});
    this.state.priorities.restore(persisted.priorities);
    this.state.mutations.mark('/');
    this.values.fanOut(['/']);
    this.children.fanOut(priors);
  }

  reset(): void {
    this.state.resetGeneration += 1;
    this.restore(null);
  }

  subscribe(onChange: () => void): () => void {
    this.state.writeSubscribers.add(onChange);
    return () => { this.state.writeSubscribers.delete(onChange); };
  }
}
