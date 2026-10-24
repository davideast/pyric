import type { AuthState } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import type { JsonValue } from './data-tree.js';
import { withPriorities } from './normalize.js';
import { canonicalPath, denyResultFor, rtdbDenialContext } from './operation-events.js';
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
    const current = this.state.tree.read(path);
    if (current === null) return;
    const now = this.state.clock.now();
    const priorPriority = this.state.priorities.get(path);
    this.state.events.operation(null, 'setPriority', path, 'not-applicable', undefined, {
      at: now,
      origin: 'admin',
      request: { data: priority },
      resourceBefore: { data: current, exists: true },
      resourceAfter: { data: current, exists: true },
      detail: { admin: true, priority, priorPriority },
    });
    const priors = this.children.snapshotParents();
    const changed = priorPriority !== priority;
    this.state.priorities.set(path, priority);
    this.state.mutations.mark(path);
    if (changed) this.values.fanOut([path]);
    this.children.fanOut(priors);
    this.state.events.commit(null, 'setPriority', path, {
      data: priority,
      priorState: priorPriority,
      nextState: priority,
      replay: { requestTime: now },
      detail: { admin: true, priority, priorPriority },
    });
    this.state.notifyWrite();
  }

  /** Decide a `setPriority` by `auth` without writing or emitting an event; throws the permission error it would throw. */
  validate(auth: AuthState, path: string, priority: Priority): void {
    validatePriority(priority);
    const evaluation = this.evaluation(auth, path, priority);
    if (evaluation.check !== 'allow') {
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'setPriority', path, { data: priority }));
    }
  }

  /** The write rules' decision on setting `path`'s priority, its value unchanged. */
  private evaluation(auth: AuthState, path: string, priority: Priority) {
    const current = this.state.tree.read(path);
    return this.state.rules.evaluate('write', path === '/' ? '/' : path, {
      auth,
      mockData: this.state.rulesSnapshot(),
      newData: withPriorities(current as JsonValue, [{ segments: [], priority }, ...this.state.prioritiesBelow(path)]),
    });
  }

  set(auth: AuthState, path: string, priority: Priority): void {
    validatePriority(priority);
    const current = this.state.tree.read(path);
    const at = this.state.clock.now();
    const evaluation = this.evaluation(auth, path, priority);
    const priorPriority = this.state.priorities.get(path);
    const common = {
      at, durationMs: this.state.clock.now() - at, request: { data: priority },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: current, exists: current !== null },
      detail: { priority, priorPriority },
    };
    if (evaluation.check !== 'allow') {
      this.state.events.operation(
        auth, 'setPriority', path, denyResultFor(evaluation.check), evaluation, common,
      );
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'setPriority', path, { data: priority }));
    }
    this.state.events.operation(auth, 'setPriority', path, 'allow', evaluation, common);
    this.state.events.commit(auth, 'setPriority', path, {
      data: priority,
      priorState: priorPriority,
      nextState: current === null ? null : priority,
      replay: { requestTime: at },
      detail: { priority, priorPriority },
    });
    if (current === null) return;
    const priors = this.children.snapshotParents();
    const changed = priorPriority !== priority;
    this.state.priorities.set(path, priority);
    this.state.mutations.mark(path);
    if (changed) this.values.fanOut([path]);
    this.children.fanOut(priors);
    if (changed) {
      this.state.events.mutation(auth, 'setPriority', canonicalPath(path), {
        before: priorPriority, after: priority, detail: { priorityMetadata: true },
      });
    }
    this.state.notifyWrite();
  }
}
