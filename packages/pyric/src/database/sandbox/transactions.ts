import type { AuthState, RtdbDenialContext } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { cloneJson, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import { coerceArrays, normalizeWrite, withPriorities, writePriority, type InlinePriority } from './normalize.js';
import { canonicalPath, denyResultFor, rtdbDenialContext } from './operation-events.js';
import { validatePriority } from './priority-state.js';
import { withDenialContext } from './rules-eval.js';
import { resolveSentinels } from './sentinels.js';
import type { ValueListeners } from './value-listeners.js';
import { captureRewindDetail, WritePlane } from './write-plane.js';

/** Production rejects a denied transaction with a codeless plain `Error`
 *  whose message is `permission_denied`. */
function transactionPermissionDenied(context: RtdbDenialContext): Error {
  return withDenialContext(new Error('permission_denied'), context);
}

export class Transactions {
  /**
   * `writes` publishes a commit as every other data write is published; the
   * backend passes its own so the two cannot drift.
   */
  constructor(
    private readonly state: BackendState,
    values: ValueListeners,
    private readonly children: ChildListeners,
    private readonly writes: WritePlane = new WritePlane(state, values, children),
  ) {}

  run(
    auth: AuthState,
    path: string,
    updateFn: (current: JsonValue) => JsonValue | undefined,
    options?: { applyLocally?: boolean; admin?: boolean },
  ): { committed: boolean; val: JsonValue; key: string | null } {
    const applyLocally = options?.applyLocally !== false;
    const isAdmin = options?.admin === true;
    const segments = pathSegments(path);
    const key = segments.length === 0 ? null : segments[segments.length - 1]!;
    let current: JsonValue = null;
    let visible: JsonValue = null;
    let proposed: JsonValue | undefined;
    let attempts = 0;
    let settled = false;
    do {
      attempts += 1;
      const version = this.state.mutations.begin();
      current = this.state.tree.read(path);
      visible = isAdmin || this.canRead(auth, path) ? current : null;
      const input = visible === null ? null : coerceArrays(cloneJson(visible)) as JsonValue;
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
        origin: isAdmin ? 'admin' : 'transaction', groupId, groupKind: 'transaction',
        resourceBefore: { data: visible, exists: visible !== null },
        detail: { committed: false, aborted: true },
      });
      return { committed: false, val: visible, key };
    }

    const now = this.state.clock.now();
    const resolved = normalizeWrite(
      resolveSentinels(proposed, now, current) as JsonValue,
      path === '/' ? '' : path,
    );
    const currentPriority = this.state.priorities.get(path);
    const written = writePriority(proposed, currentPriority);
    validatePriority(written.priority);
    const effectivePriority = resolved === null ? null : written.priority;
    const at = this.state.clock.now();
    let evaluation: ReturnType<BackendState['rules']['evaluate']> | undefined;
    if (!isAdmin) {
      const newData = withPriorities(resolved, [
        { segments: [], priority: effectivePriority },
        ...written.nested,
      ]);
      evaluation = this.state.rules.evaluate('write', path, {
        auth, mockData: this.state.rulesSnapshot(), newData, now,
      });
      if (evaluation.check !== 'allow') {
        this.state.events.operation(auth, 'transaction', path, denyResultFor(evaluation.check), evaluation, {
          at, durationMs: this.state.clock.now() - at, origin: 'transaction',
          request: { data: proposed, resourceData: proposed },
          resourceBefore: { data: current, exists: current !== null },
          resourceAfter: { data: resolved, exists: resolved !== null },
          groupId, groupKind: 'transaction',
        });
        throw transactionPermissionDenied(rtdbDenialContext(evaluation, auth, 'transaction', path, { data: proposed }));
      }
    }
    const hasNode = (p: string): boolean => this.state.tree.read(p) !== null;
    const rewindDetail = captureRewindDetail(this.state, path, current, currentPriority, true);
    // A commit is recorded as a set is: its operation, then the revocations
    // and deliveries it causes, then the commit itself.
    const opResult = isAdmin ? 'not-applicable' : 'allow';
    const opOrigin = isAdmin ? 'admin' : 'transaction';
    this.state.events.operation(auth, 'transaction', path, opResult, evaluation, {
      at, durationMs: this.state.clock.now() - at, origin: opOrigin,
      request: { data: proposed, resourceData: proposed },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
      groupId, groupKind: 'transaction',
    });
    const childPriors = this.children.snapshotParents();
    this.state.tree.write(path, resolved);
    this.state.priorities.replace(path, effectivePriority, hasNode);
    this.storeNestedPriorities(segments, written.nested, hasNode);
    this.writes.changed([path], childPriors);
    this.finishEvents(auth, path, proposed, current, resolved, groupId, now, applyLocally, isAdmin, rewindDetail);
    this.state.notifyWrite();
    return { committed: true, val: resolved, key };
  }

  private storeNestedPriorities(
    baseSegments: string[],
    nested: readonly InlinePriority[],
    hasNode: (path: string) => boolean,
  ): void {
    for (const { segments, priority } of nested) {
      const target = joinPath([...baseSegments, ...segments]);
      this.state.priorities.set(target, hasNode(target) ? priority : null);
    }
  }

  private canRead(auth: AuthState, path: string): boolean {
    const evaluation = this.state.rules.evaluate('read', path, {
      auth,
      mockData: this.state.rulesSnapshot(),
      now: this.state.clock.now(),
    });
    return evaluation.check === 'allow';
  }

  private finishEvents(
    auth: AuthState, path: string, proposed: JsonValue, current: JsonValue,
    resolved: JsonValue, groupId: string, now: number, applyLocally: boolean,
    isAdmin: boolean, rewindDetail: Record<string, unknown>,
  ): void {
    this.state.events.commit(auth, 'transaction', path, {
      data: proposed, priorState: current, nextState: resolved,
      groupId, groupKind: 'transaction', replay: { requestTime: now },
      detail: {
        ...(isAdmin ? { admin: true } : {}),
        committed: true,
        applyLocally,
        ...rewindDetail,
      },
    });
    this.state.events.mutation(auth, 'transaction', canonicalPath(path), {
      before: current, after: resolved, detail: { committed: true },
    });
  }
}
