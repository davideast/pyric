import type { AuthState } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import type { JsonValue } from './data-tree.js';
import { canonicalPath, denyResultFor } from './operation-events.js';
import { validatePriority } from './priority-state.js';
import type { Priority } from './query.js';
import { permissionDenied } from './rules-eval.js';
import type { ValueListeners } from './value-listeners.js';

/** Priority-only writes and their listener/history propagation. */
export class PriorityWrites {
  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
  ) {}

  adminSet(path: string, priority: Priority): void {
    validatePriority(priority);
    if (this.state.tree.read(path) === null) return;
    const priors = this.children.snapshotParents();
    const changed = this.state.priorities.get(path) !== priority;
    this.state.priorities.set(path, priority);
    this.state.mutations.mark(path);
    if (changed) this.values.fanOut([path]);
    this.children.fanOut(priors, changed ? path : undefined);
    this.state.notifyWrite();
  }

  set(auth: AuthState, path: string, priority: Priority): void {
    validatePriority(priority);
    const current = this.state.tree.read(path);
    const at = Date.now();
    const evaluation = this.state.rules.evaluate('write', path === '/' ? '/' : path, {
      auth,
      mockData: this.state.tree.snapshot() as Record<string, unknown>,
      newData: current as JsonValue,
    });
    const priorPriority = this.state.priorities.get(path);
    const common = {
      at, durationMs: Date.now() - at, request: { data: priority },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: current, exists: current !== null },
      detail: { priority, priorPriority },
    };
    if (evaluation.check !== 'allow') {
      this.state.events.operation(
        auth, 'setPriority', path, denyResultFor(evaluation.check), evaluation, common,
      );
      throw permissionDenied();
    }
    this.state.events.operation(auth, 'setPriority', path, 'allow', evaluation, common);
    if (current === null) return;
    const priors = this.children.snapshotParents();
    const changed = priorPriority !== priority;
    this.state.priorities.set(path, priority);
    this.state.mutations.mark(path);
    if (changed) this.values.fanOut([path]);
    this.children.fanOut(priors, changed ? path : undefined);
    if (changed) {
      this.state.events.commit(auth, 'setPriority', path, {
        data: priority, priorState: priorPriority, nextState: priority,
        detail: { priority, priorPriority },
      });
      this.state.events.mutation(auth, 'setPriority', canonicalPath(path), {
        before: priorPriority, after: priority, detail: { priorityMetadata: true },
      });
    }
    this.state.notifyWrite();
  }
}
