import type { AuthState, RtdbDenialContext } from 'pyric/sandbox';
import { renderSnapshotVal } from '../snapshots.js';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { joinPath, pathSegments, type JsonValue } from './data-tree.js';
import {
  normalizeWrite,
  TRANSACTION_ERROR_PREFIX,
  validateTransactionCandidate,
  withPriorities,
  writePriority,
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
  validateTransactionCandidate(proposed, path);
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

export interface ClientTransactionHooks {
  runUpdate<R>(fn: () => R): R;
  onWarm(): void;
  onSent(): {
    readonly isAbortedBySet: () => boolean;
    readonly release: () => void;
  };
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

export interface AsyncClientTransactionOptions {
  readonly applyLocally?: boolean;
  readonly admin?: boolean;
  readonly cold?: boolean;
  readonly hooks?: ClientTransactionHooks;
}

function runUpdateWithHooks(
  hooks: ClientTransactionHooks | undefined,
  updateFn: (current: JsonValue) => JsonValue | undefined,
  input: JsonValue,
): JsonValue | undefined {
  if (hooks !== undefined) {
    return hooks.runUpdate(() => updateFn(input));
  }
  return updateFn(input);
}

function readWarmTransactionInput(
  state: BackendState,
  pendingWrites: PendingClientWrites,
  auth: AuthState,
  path: string,
  isAdmin: boolean,
): { visible: JsonValue; input: JsonValue } {
  const snapshot = pendingWrites.readCommitted(() => {
    const cur = state.tree.read(path);
    const canRead = isAdmin || canReadAtPath(state, auth, path);
    let prio: PriorityRecord = {};
    if (canRead && cur !== null) {
      prio = state.priorities.atOrBelow(path);
    }
    return { cur, canRead, prio };
  });
  let visible: JsonValue = null;
  if (snapshot.canRead) {
    visible = snapshot.cur;
  }
  let input: JsonValue = null;
  if (visible !== null) {
    input = renderSnapshotVal(path, visible, (p) => {
      const canonical = joinPath(pathSegments(p));
      if (!Object.hasOwn(snapshot.prio, canonical)) return null;
      const stored = snapshot.prio[canonical];
      return stored === undefined ? null : stored;
    });
  }
  return { visible, input };
}

function abortTransactionOutcome(
  deps: AsyncClientTransactionDeps,
  withProvenance: <T>(fn: () => T) => T,
  auth: AuthState,
  path: string,
  key: string | null,
  visible: JsonValue,
  isAdmin: boolean,
): ClientTransactionOutcome {
  const { state, pendingWrites } = deps;
  return pendingWrites.runAgainstServer([], () =>
    withProvenance(() => {
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
    }),
  );
}

function commitTransactionCandidate(
  deps: AsyncClientTransactionDeps,
  withProvenance: <T>(fn: () => T) => T,
  auth: AuthState,
  path: string,
  segments: readonly string[],
  key: string | null,
  candidate: JsonValue,
  applyLocally: boolean,
  isAdmin: boolean,
): ClientTransactionOutcome {
  const { state, children, writes, pendingWrites } = deps;
  return pendingWrites.runAgainstServer([path], () =>
    withProvenance(() => {
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
    }),
  );
}

async function continueWarmTransactionLoop(
  deps: AsyncClientTransactionDeps,
  withProvenance: <T>(fn: () => T) => T,
  auth: AuthState,
  path: string,
  segments: readonly string[],
  key: string | null,
  updateFn: (current: JsonValue) => JsonValue | undefined,
  applyLocally: boolean,
  isAdmin: boolean,
  hooks: ClientTransactionHooks | undefined,
  startAttempt: number,
): Promise<ClientTransactionOutcome> {
  const { state, pendingWrites } = deps;
  for (let attempts = startAttempt; attempts <= 25; attempts += 1) {
    const version = state.mutations.begin();
    let visible: JsonValue = null;
    let proposed: JsonValue | undefined;
    let syncConflicted = false;
    try {
      const readResult = readWarmTransactionInput(state, pendingWrites, auth, path, isAdmin);
      visible = readResult.visible;
      proposed = runUpdateWithHooks(hooks, updateFn, readResult.input);
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
      hooks?.onWarm();
      return abortTransactionOutcome(deps, withProvenance, auth, path, key, visible, isAdmin);
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

    hooks?.onWarm();
    return commitTransactionCandidate(
      deps,
      withProvenance,
      auth,
      path,
      segments,
      key,
      proposed,
      applyLocally,
      isAdmin,
    );
  }

  throw new Error('maxretry');
}

export function runClientTransactionAsync(
  deps: AsyncClientTransactionDeps,
  auth: AuthState,
  path: string,
  updateFn: (current: JsonValue) => JsonValue | undefined,
  options?: AsyncClientTransactionOptions,
): Promise<ClientTransactionOutcome> {
  const { state, pendingWrites } = deps;
  const withProvenance = state.events.captureProvenanceWindow();
  const applyLocally = options?.applyLocally !== false;
  const isAdmin = options?.admin === true;
  const hooks = options?.hooks;
  const segments = pathSegments(path);
  let key: string | null = null;
  if (segments.length > 0) {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg !== undefined) {
      key = lastSeg;
    }
  }

  if (options?.cold === true && !isAdmin && hooks !== undefined) {
    const version0 = state.mutations.begin();
    let proposed0: JsonValue | undefined;
    let syncConflicted0 = false;
    try {
      proposed0 = runUpdateWithHooks(hooks, updateFn, null);
      if (proposed0 !== undefined) {
        validateProposedCandidate(state, path, segments, proposed0);
      }
      syncConflicted0 = state.mutations.conflictsSince(version0, path);
    } catch (err) {
      state.mutations.release(version0);
      throw err;
    }

    if (proposed0 === undefined) {
      state.mutations.release(version0);
      return Promise.resolve().then(() =>
        abortTransactionOutcome(deps, withProvenance, auth, path, key, null, false),
      );
    }

    if (syncConflicted0) {
      state.mutations.release(version0);
      hooks.onWarm();
      return continueWarmTransactionLoop(
        deps, withProvenance, auth, path, segments, key, updateFn, applyLocally, false, hooks, 2,
      );
    }

    const candidate0 = proposed0;
    const sent = hooks.onSent();
    return (async (): Promise<ClientTransactionOutcome> => {
      let conflictedOnWire0 = false;
      let callerVisibleNonNull = false;
      try {
        await Promise.resolve();
        conflictedOnWire0 = state.mutations.conflictsSince(version0, path);
        callerVisibleNonNull = pendingWrites.readCommitted(
          () => state.tree.read(path) !== null && canReadAtPath(state, auth, path),
        );
      } finally {
        sent.release();
        state.mutations.release(version0);
      }

      if (!conflictedOnWire0 && !callerVisibleNonNull) {
        hooks.onWarm();
        return commitTransactionCandidate(
          deps, withProvenance, auth, path, segments, key, candidate0, applyLocally, false,
        );
      }

      if (sent.isAbortedBySet()) {
        throw new Error('set');
      }
      hooks.onWarm();
      return continueWarmTransactionLoop(
        deps, withProvenance, auth, path, segments, key, updateFn, applyLocally, false, hooks, 2,
      );
    })();
  }

  const version1 = state.mutations.begin();
  let visible1: JsonValue = null;
  let proposed1: JsonValue | undefined;
  let syncConflicted1 = false;
  try {
    const readResult1 = readWarmTransactionInput(state, pendingWrites, auth, path, isAdmin);
    visible1 = readResult1.visible;
    proposed1 = runUpdateWithHooks(hooks, updateFn, readResult1.input);
    if (proposed1 !== undefined) {
      validateProposedCandidate(state, path, segments, proposed1);
    }
    syncConflicted1 = state.mutations.conflictsSince(version1, path);
  } catch (err) {
    state.mutations.release(version1);
    throw err;
  }

  if (proposed1 === undefined) {
    state.mutations.release(version1);
    hooks?.onWarm();
    return Promise.resolve().then(() =>
      abortTransactionOutcome(deps, withProvenance, auth, path, key, visible1, isAdmin),
    );
  }

  if (syncConflicted1) {
    state.mutations.release(version1);
    return continueWarmTransactionLoop(
      deps, withProvenance, auth, path, segments, key, updateFn, applyLocally, isAdmin, hooks, 2,
    );
  }

  const candidate1 = proposed1;
  return (async (): Promise<ClientTransactionOutcome> => {
    let conflictedOnWire1 = false;
    try {
      await Promise.resolve();
      conflictedOnWire1 = state.mutations.conflictsSince(version1, path);
    } finally {
      state.mutations.release(version1);
    }
    if (conflictedOnWire1) {
      return continueWarmTransactionLoop(
        deps, withProvenance, auth, path, segments, key, updateFn, applyLocally, isAdmin, hooks, 2,
      );
    }
    hooks?.onWarm();
    return commitTransactionCandidate(
      deps, withProvenance, auth, path, segments, key, candidate1, applyLocally, isAdmin,
    );
  })();
}
