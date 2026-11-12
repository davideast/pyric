import type { AuthState } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { canonicalPath, denyResultFor, rtdbDenialContext } from './operation-events.js';
import { validatePriority } from './priority-state.js';
import type { Priority } from './query.js';
import { permissionDenied } from './rules-eval.js';
import { resolveSentinels } from './sentinels.js';

/** Publishes a write applied at `paths`; see `WritePlane.changed`. */
export type PublishWrite = (paths: string[], priors: ReturnType<ChildListeners['snapshotParents']>) => void;

/** Priority-only writes; each publishes through the same step as every other data write. */
export class PriorityWrites {
  constructor(
    private readonly state: BackendState,
    private readonly children: ChildListeners,
    private readonly publish: PublishWrite,
  ) {}

  private resolvePriorityWrite(path: string, priority: Priority): {
    now: number;
    priorPriority: Priority;
    resolvedPriority: Priority;
  } {
    const now = this.state.clock.now();
    const priorPriority = this.state.priorities.get(path);
    const resolvedPriority = resolveSentinels(priority, now, priorPriority) as Priority;
    validatePriority(resolvedPriority);
    return { now, priorPriority, resolvedPriority };
  }

  adminSet(path: string, priority: Priority): void {
    const { now, priorPriority, resolvedPriority } = this.resolvePriorityWrite(path, priority);
    const current = this.state.tree.read(path);
    if (current === null) return;
    this.state.events.operation(null, 'setPriority', path, 'not-applicable', undefined, {
      at: now,
      origin: 'admin',
      request: { data: priority },
      resourceBefore: { data: current, exists: true },
      resourceAfter: { data: current, exists: true },
      detail: { admin: true, priority: resolvedPriority, priorPriority },
    });
    const priors = this.children.snapshotParents();
    this.state.priorities.set(path, resolvedPriority);
    this.publish([path], priors);
    this.state.events.commit(null, 'setPriority', path, {
      data: priority,
      priorState: priorPriority,
      nextState: resolvedPriority,
      replay: { requestTime: now },
      detail: { admin: true, priority: resolvedPriority, priorPriority },
    });
    this.state.notifyWrite();
  }

  /** Decide a `setPriority` by `auth` without writing or emitting an event; throws the permission error it would throw. */
  validate(auth: AuthState, path: string, priority: Priority): void {
    const { now, resolvedPriority } = this.resolvePriorityWrite(path, priority);
    const evaluation = this.evaluation(auth, path, resolvedPriority, now);
    if (evaluation.check !== 'allow') {
      throw permissionDenied(rtdbDenialContext(evaluation, auth, 'setPriority', path, { data: priority }));
    }
  }

  /** The write rules' decision on setting `path`'s priority, its value unchanged. */
  private evaluation(auth: AuthState, path: string, priority: Priority, now: number) {
    const canonical = canonicalPath(path);
    const priorityPath = canonical === '/' ? '/.priority' : `${canonical}/.priority`;
    return this.state.rules.evaluate('write', priorityPath, {
      auth,
      mockData: this.state.rulesSnapshot(),
      newData: priority,
      now,
    });
  }

  set(auth: AuthState, path: string, priority: Priority): void {
    const { now: at, priorPriority, resolvedPriority } = this.resolvePriorityWrite(path, priority);
    const current = this.state.tree.read(path);
    const evaluation = this.evaluation(auth, path, resolvedPriority, at);
    const common = {
      at, durationMs: this.state.clock.now() - at, request: { data: priority },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: current, exists: current !== null },
      detail: { priority: resolvedPriority, priorPriority },
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
      nextState: current === null ? null : resolvedPriority,
      replay: { requestTime: at },
      detail: { priority: resolvedPriority, priorPriority },
    });
    if (current === null) return;
    const priors = this.children.snapshotParents();
    const changed = priorPriority !== resolvedPriority;
    this.state.priorities.set(path, resolvedPriority);
    this.publish([path], priors);
    if (changed) {
      this.state.events.mutation(auth, 'setPriority', canonicalPath(path), {
        before: priorPriority, after: resolvedPriority, detail: { priorityMetadata: true },
      });
    }
    this.state.notifyWrite();
  }
}
