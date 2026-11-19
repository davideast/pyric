import type { AuthState, RtdbDenialContext } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { cloneJson, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import {
  coerceArrays,
  normalizeWrite,
  TRANSACTION_ERROR_PREFIX,
  withPriorities,
  writePriority,
  type InlinePriority,
} from './normalize.js';
import { canonicalPath, denyResultFor, rtdbDenialContext } from './operation-events.js';
import type { PendingClientWrites } from './pending-client-writes.js';
import { validateNestedPriorities, validatePriority, type PriorityRecord } from './priority-state.js';
import type { Priority } from './query.js';
import { withDenialContext } from './rules-eval.js';
import { resolveSentinels } from './sentinels.js';
import { captureRewindDetail, type WritePlane } from './write-plane.js';

function transactionPermissionDenied(context: RtdbDenialContext): Error {
  return withDenialContext(new Error('permission_denied'), context);
}

function readSubtree(root: JsonValue, segments: readonly string[]): JsonValue {
  let current: JsonValue = root;
  for (const segment of segments) {
    if (
      current === null
      || typeof current !== 'object'
      || Array.isArray(current)
      || !Object.hasOwn(current, segment)
    ) {
      return null;
    }
    const next = (current as Record<string, JsonValue>)[segment];
    if (next === undefined) {
      return null;
    }
    current = next;
  }
  return current;
}

function buildCallerVisibleCommit(
  path: string,
  proposed: JsonValue | undefined,
  now: number,
): { val: JsonValue; priorities: PriorityRecord } {
  const resolvedInput = resolveSentinels(proposed, now, null);
  let normPath = path;
  if (path === '/') {
    normPath = '';
  }
  const val = normalizeWrite(resolvedInput, normPath, TRANSACTION_ERROR_PREFIX);
  if (val === null) {
    return { val: null, priorities: {} };
  }
  const written = writePriority(resolvedInput, null);
  const priorities: PriorityRecord = {};
  const baseSegments = pathSegments(path);
  if (written.inline && written.priority !== null) {
    priorities[joinPath(baseSegments)] = written.priority;
  }
  for (const entry of written.nested) {
    if (entry.priority === null) {
      continue;
    }
    if (readSubtree(val, entry.segments) !== null) {
      priorities[joinPath([...baseSegments, ...entry.segments])] = entry.priority;
    }
  }
  return { val, priorities };
}

function canReadAtPath(state: BackendState, auth: AuthState, path: string): boolean {
  const evaluation = state.rules.evaluate('read', path, {
    auth,
    mockData: state.rulesSnapshot(),
    now: state.clock.now(),
  });
  return evaluation.check === 'allow';
}

function validateProposedCandidate(
  state: BackendState,
  path: string,
  segments: readonly string[],
  proposed: JsonValue,
): void {
  const now = state.clock.now();
  const resolvedInput = resolveSentinels(proposed, now, null);
  let normPath = path;
  if (path === '/') {
    normPath = '';
  }
  normalizeWrite(resolvedInput, normPath, TRANSACTION_ERROR_PREFIX);
  const written = writePriority(resolvedInput, null);
  validatePriority(written.priority);
  validateNestedPriorities(segments, written.nested);
}

export interface AsyncClientTransactionDeps {
  readonly state: BackendState;
  readonly children: ChildListeners;
  readonly writes: WritePlane;
  readonly pendingWrites: PendingClientWrites;
}

export interface ClientTransactionOutcome {
  committed: boolean;
  val: JsonValue;
  key: string | null;
  priorities?: PriorityRecord;
}

export async function runClientTransactionAsync(
  deps: AsyncClientTransactionDeps,
  auth: AuthState,
  path: string,
  updateFn: (current: JsonValue) => JsonValue | undefined,
  options?: { applyLocally?: boolean; admin?: boolean },
): Promise<ClientTransactionOutcome> {
  const { state, children, writes, pendingWrites } = deps;
  const applyLocally = options?.applyLocally !== false;
  const isAdmin = options?.admin === true;
  const segments = pathSegments(path);
  let key: string | null = null;
  if (segments.length > 0) {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg !== undefined) {
      key = lastSeg;
    }
  }

  for (let attempts = 1; attempts <= 25; attempts += 1) {
    const version = state.mutations.begin();
    let visible: JsonValue = null;
    let proposed: JsonValue | undefined;
    let syncConflicted = false;
    try {
      const snapshot = pendingWrites.readCommitted(() => {
        const cur = state.tree.read(path);
        const canRead = isAdmin || canReadAtPath(state, auth, path);
        return { cur, canRead };
      });
      if (snapshot.canRead) {
        visible = snapshot.cur;
      } else {
        visible = null;
      }
      let input: JsonValue = null;
      if (visible !== null) {
        input = coerceArrays(cloneJson(visible)) as JsonValue;
      }
      proposed = updateFn(input);
      if (proposed !== undefined) {
        validateProposedCandidate(state, path, segments, proposed);
      }
      syncConflicted = state.mutations.conflictsSince(version, path);
    } catch (err) {
      state.mutations.release(version);
      throw err;
    }

    if (proposed === undefined) {
      state.mutations.release(version);
      return pendingWrites.runAgainstServer([], () => {
        const groupId = state.events.nextGroupId('transaction');
        let origin: 'admin' | 'transaction' = 'transaction';
        if (isAdmin) {
          origin = 'admin';
        }
        state.events.operation(auth, 'transaction', path, 'not-applicable', undefined, {
          origin,
          groupId,
          groupKind: 'transaction',
          resourceBefore: { data: visible, exists: visible !== null },
          detail: { committed: false, aborted: true },
        });
        let abortedPrio: PriorityRecord = {};
        if (visible !== null) {
          abortedPrio = state.priorities.atOrBelow(path);
        }
        return {
          committed: false,
          val: visible,
          key,
          priorities: abortedPrio,
        };
      });
    }

    if (syncConflicted) {
      state.mutations.release(version);
      continue;
    }

    let conflictedOnWire = false;
    try {
      await Promise.resolve();
      conflictedOnWire = state.mutations.conflictsSince(version, path);
    } finally {
      state.mutations.release(version);
    }
    if (conflictedOnWire) {
      continue;
    }

    const candidate = proposed;
    return pendingWrites.runAgainstServer([path], () => {
      const current = state.tree.read(path);
      const groupId = state.events.nextGroupId('transaction');
      const now = state.clock.now();
      const currentPriority = state.priorities.get(path);
      const resolvedInput = resolveSentinels(candidate, now, state.rulesSnapshotAt(path));
      let normPath = path;
      if (path === '/') {
        normPath = '';
      }
      const resolved = normalizeWrite(resolvedInput, normPath, TRANSACTION_ERROR_PREFIX);
      const written = writePriority(resolvedInput, currentPriority);
      validatePriority(written.priority);
      validateNestedPriorities(segments, written.nested);
      let effectivePriority: Priority = null;
      if (resolved !== null) {
        effectivePriority = written.priority;
      }
      const at = state.clock.now();
      let evaluation: ReturnType<BackendState['rules']['evaluate']> | undefined;
      if (!isAdmin) {
        const newData = withPriorities(resolved, [
          { segments: [], priority: effectivePriority },
          ...written.nested,
        ]);
        evaluation = state.rules.evaluate('write', path, {
          auth,
          mockData: state.rulesSnapshot(),
          newData,
          now,
        });
        if (evaluation.check !== 'allow') {
          let denyDetail: { priority: Priority } | undefined;
          if (effectivePriority !== null) {
            denyDetail = { priority: effectivePriority };
          }
          state.events.operation(
            auth,
            'transaction',
            path,
            denyResultFor(evaluation.check),
            evaluation,
            {
              at,
              durationMs: state.clock.now() - at,
              origin: 'transaction',
              request: { data: candidate, resourceData: candidate },
              resourceBefore: { data: current, exists: current !== null },
              resourceAfter: { data: resolved, exists: resolved !== null },
              groupId,
              groupKind: 'transaction',
              detail: denyDetail,
            },
          );
          throw transactionPermissionDenied(
            rtdbDenialContext(evaluation, auth, 'transaction', path, { data: candidate }),
          );
        }
      }

      const hasNode = (p: string): boolean => state.tree.read(p) !== null;
      const rewindDetail = captureRewindDetail(state, path, current, currentPriority, true);
      let opResult: 'not-applicable' | 'allow' = 'allow';
      let opOrigin: 'admin' | 'transaction' = 'transaction';
      if (isAdmin) {
        opResult = 'not-applicable';
        opOrigin = 'admin';
      }
      state.events.operation(auth, 'transaction', path, opResult, evaluation, {
        at,
        durationMs: state.clock.now() - at,
        origin: opOrigin,
        request: { data: candidate, resourceData: candidate },
        resourceBefore: { data: current, exists: current !== null },
        resourceAfter: { data: resolved, exists: resolved !== null },
        groupId,
        groupKind: 'transaction',
      });
      const childPriors = children.snapshotParents();
      state.tree.write(path, resolved);
      state.priorities.replace(path, effectivePriority, hasNode);
      for (const entry of written.nested) {
        const nestedPath = joinPath([...segments, ...entry.segments]);
        let nestedPrio: Priority = null;
        if (hasNode(nestedPath)) {
          nestedPrio = entry.priority;
        }
        state.priorities.set(nestedPath, nestedPrio);
      }
      writes.changed([path], childPriors);
      const commitDetail: Record<string, unknown> = {
        committed: true,
        applyLocally,
        ...rewindDetail,
      };
      if (isAdmin) {
        commitDetail.admin = true;
      }
      state.events.commit(auth, 'transaction', path, {
        data: candidate,
        priorState: current,
        nextState: resolved,
        groupId,
        groupKind: 'transaction',
        replay: { requestTime: now },
        detail: commitDetail,
      });
      state.events.mutation(auth, 'transaction', canonicalPath(path), {
        before: current,
        after: resolved,
        detail: { committed: true },
      });
      state.notifyWrite();

      if (isAdmin || canReadAtPath(state, auth, path)) {
        let committedPrio: PriorityRecord = {};
        if (resolved !== null) {
          committedPrio = state.priorities.atOrBelow(path);
        }
        return {
          committed: true,
          val: resolved,
          key,
          priorities: committedPrio,
        };
      }
      const redacted = buildCallerVisibleCommit(path, candidate, now);
      return {
        committed: true,
        val: redacted.val,
        key,
        priorities: redacted.priorities,
      };
    });
  }

  throw new Error('maxretry');
}
