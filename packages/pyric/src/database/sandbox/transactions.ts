import type { AuthState } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import { cloneJson, pathSegments, type JsonValue } from './data-tree.js';
import { coerceArrays, normalizeWrite } from './normalize.js';
import { canonicalPath, denyResultFor } from './operation-events.js';
import { resolveSentinels } from './sentinels.js';
import type { ValueListeners } from './value-listeners.js';

function transactionPermissionDenied(): Error {
  return new Error('permission_denied');
}

export class Transactions {
  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
  ) {}

  run(
    auth: AuthState,
    path: string,
    updateFn: (current: JsonValue) => JsonValue | undefined,
    options?: { applyLocally?: boolean },
  ): { committed: boolean; val: JsonValue; key: string | null } {
    const applyLocally = options?.applyLocally !== false;
    const segments = pathSegments(path);
    const key = segments.length === 0 ? null : segments[segments.length - 1]!;
    let current: JsonValue = null;
    let proposed: JsonValue | undefined;
    let attempts = 0;
    let settled = false;
    do {
      attempts += 1;
      const version = this.state.mutations.begin();
      current = this.state.tree.read(path);
      const input = current === null ? null : coerceArrays(cloneJson(current)) as JsonValue;
      let conflicted = false;
      try {
        proposed = updateFn(input);
        conflicted = this.state.mutations.conflictsSince(version, path);
      } finally {
        this.state.mutations.release(version);
      }
      if (!conflicted || proposed === undefined) {
        settled = true;
        break;
      }
    } while (attempts < 25);
    if (!settled) throw new Error('maxretry');

    const groupId = this.state.events.nextGroupId('transaction');
    if (proposed === undefined) {
      this.state.events.operation(auth, 'transaction', path, 'not-applicable', undefined, {
        origin: 'transaction', groupId, groupKind: 'transaction',
        resourceBefore: { data: current, exists: current !== null },
        detail: { committed: false, aborted: true },
      });
      return { committed: false, val: current, key };
    }

    const now = Date.now();
    const resolved = normalizeWrite(
      resolveSentinels(proposed, now, current) as JsonValue,
      path === '/' ? '' : path,
    );
    if (applyLocally) {
      const priorRoot = this.state.tree.snapshot();
      const priorPriorities = Object.fromEntries(this.state.priorities.entries());
      const currentPriority = this.state.priorities.get(path);
      this.state.tree.write(path, resolved);
      this.state.priorities.replace(path, currentPriority);
      this.values.fanOut([path]);
      const at = Date.now();
      const evaluation = this.state.rules.evaluate('write', path === '/' ? '/' : path, {
        auth, mockData: priorRoot as Record<string, unknown>, newData: resolved,
      });
      if (evaluation.check !== 'allow') {
        this.state.events.operation(auth, 'transaction', path, denyResultFor(evaluation.check), evaluation, {
          at, durationMs: Date.now() - at, origin: 'transaction',
          request: { data: proposed, resourceData: proposed },
          resourceBefore: { data: current, exists: current !== null },
          resourceAfter: { data: resolved, exists: resolved !== null },
          groupId, groupKind: 'transaction',
        });
        this.state.tree.restore(priorRoot);
        this.state.priorities.restore(priorPriorities);
        this.values.fanOut([path]);
        throw transactionPermissionDenied();
      }
      this.recordCommit(auth, path, proposed, current, resolved, groupId, now, at, true, evaluation);
      return { committed: true, val: resolved, key };
    }

    const at = Date.now();
    const evaluation = this.state.rules.evaluate('write', path === '/' ? '/' : path, {
      auth, mockData: this.state.tree.snapshot() as Record<string, unknown>, newData: resolved,
    });
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'transaction', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: Date.now() - at, origin: 'transaction',
        request: { data: proposed, resourceData: proposed },
        resourceBefore: { data: current, exists: current !== null },
        resourceAfter: { data: resolved, exists: resolved !== null },
        groupId, groupKind: 'transaction',
      });
      throw transactionPermissionDenied();
    }
    this.state.events.operation(auth, 'transaction', path, 'allow', evaluation, {
      at, durationMs: Date.now() - at, origin: 'transaction',
      request: { data: proposed, resourceData: proposed },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
      groupId, groupKind: 'transaction',
    });
    const priority = this.state.priorities.get(path);
    this.state.tree.write(path, resolved);
    this.state.priorities.replace(path, priority);
    this.state.mutations.mark(path);
    this.values.fanOut([path]);
    this.finishEvents(auth, path, proposed, current, resolved, groupId, now, false);
    return { committed: true, val: resolved, key };
  }

  private recordCommit(
    auth: AuthState, path: string, proposed: JsonValue, current: JsonValue,
    resolved: JsonValue, groupId: string, now: number, at: number, applyLocally: boolean,
    evaluation: ReturnType<BackendState['rules']['evaluate']>,
  ): void {
    this.state.events.operation(auth, 'transaction', path, 'allow', evaluation, {
      at, durationMs: Date.now() - at, origin: 'transaction',
      request: { data: proposed, resourceData: proposed },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
      groupId, groupKind: 'transaction',
    });
    this.finishEvents(auth, path, proposed, current, resolved, groupId, now, applyLocally);
    this.state.mutations.mark(path);
    this.state.notifyWrite();
  }

  private finishEvents(
    auth: AuthState, path: string, proposed: JsonValue, current: JsonValue,
    resolved: JsonValue, groupId: string, now: number, applyLocally: boolean,
  ): void {
    this.state.events.commit(auth, 'transaction', path, {
      data: proposed, priorState: current, nextState: resolved,
      groupId, groupKind: 'transaction', replay: { requestTime: now },
      detail: { committed: true, applyLocally },
    });
    this.state.events.mutation(auth, 'transaction', canonicalPath(path), {
      before: current, after: resolved, detail: { committed: true },
    });
  }
}
