import { assertCompleteHistory } from '../sandbox/internal/history-integrity.js';
import {
  initializeSandbox,
  type Sandbox,
  type SandboxCommitEvent,
  type SandboxEvent,
  type SandboxOperationEvent,
} from '../sandbox/index.js';
import {
  get,
  getAdminDatabase,
  getDatabase,
  query,
  ref,
  remove,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  update,
  sandbox as rtdbSandbox,
  type Database,
  type QueryConstraint,
} from './index.js';
import type { QuerySpec } from './internal/query-projection.js';
import { buildConstraint } from './query-shape.js';
import { isJsonObject, jsonValuesEqual } from './sandbox/data-tree.js';

export interface RtdbReplayOptions {
  rules: { rules: Record<string, unknown> };
  capturedState?: unknown;
}

export interface RtdbReplayResult {
  ok: boolean;
  sandbox: Sandbox;
  checkedEvents: number;
  replayedState: unknown;
  divergences: RtdbReplayDivergence[];
}

export type RtdbReplayDivergence =
  | {
      kind: 'now-denied';
      path?: string;
      method?: string;
      reason?: string;
    }
  | {
      kind: 'state-drift';
      path?: string;
      before: unknown;
      after: unknown;
    }
  | {
      kind: 'unsupported';
      path?: string;
      method?: string;
      reason: string;
    };

export async function replay(
  events: readonly SandboxEvent[],
  opts: RtdbReplayOptions,
): Promise<RtdbReplayResult> {
  assertCompleteHistory(events);
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  const adminDb = getAdminDatabase(sandbox);
  rtdbSandbox.setRules(db, opts.rules);

  const commits = events.filter(isRtdbCommit);
  const divergences: RtdbReplayDivergence[] = [];
  let checkedEvents = 0;
  const hasCapturedState = opts.capturedState !== undefined;

  if (hasCapturedState) {
    rtdbSandbox.setData(adminDb, { '/': opts.capturedState });
    await rewindRtdbCommits(adminDb, commits);
  }

  for (const event of events) {
    if (isAllowedQueryRead(event)) {
      checkedEvents += 1;
      await replayRtdbQueryRead(sandbox, event, divergences);
      continue;
    }
    if (!isRtdbCommit(event)) continue;
    const commit = event;
    const path = commit.path ?? '/';
    const isAdmin = commit.detail?.admin === true;
    if (isAdmin) {
      await replayRtdbAdminCommit(sandbox, commit, divergences);
      continue;
    }

    checkedEvents += 1;
    try {
      await replayRtdbAppCommit(sandbox, commit, divergences);
    } catch (e) {
      const isError = e instanceof Error;
      divergences.push({
        kind: 'now-denied',
        path,
        method: commit.method,
        reason: isError ? e.message : String(e),
      });
    }
  }

  const replayedState = rtdbSandbox.snapshotState(adminDb);
  if (hasCapturedState) {
    collectStateDrift(opts.capturedState, replayedState, '/', divergences);
  }

  return {
    ok: divergences.length === 0,
    sandbox,
    checkedEvents,
    replayedState,
    divergences,
  };
}

async function replayRtdbAppCommit(
  sandbox: ReturnType<typeof initializeSandbox>,
  commit: SandboxCommitEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  const prev = sandbox.currentUser;
  sandbox.currentUser = commit.auth;
  try {
    const db = getDatabase(sandbox);
    await replayRtdbCommitWithDatabase(db, commit, divergences);
  } finally {
    sandbox.currentUser = prev;
  }
}

/**
 * A one-shot read by an application user that carried a query and was
 * allowed. Its `query.*` rule expressions are what the candidate rules are
 * judged on. A read with no query, an admin read, and a denied read carry no
 * claim the candidate rules must keep.
 */
function isAllowedQueryRead(event: SandboxEvent): event is SandboxOperationEvent {
  return event.kind === 'operation'
    && event.service === 'rtdb'
    && event.method === 'get'
    && event.origin !== 'admin'
    && event.result === 'allow'
    && event.request?.query !== undefined;
}

/** The constraints that rebuild a captured query, in the order the SDK applies them. */
function constraintsOfSpec(spec: QuerySpec): QueryConstraint[] {
  const constraints: QueryConstraint[] = [];
  if (spec.orderBy !== null) {
    const type = {
      child: 'orderByChild',
      key: 'orderByKey',
      priority: 'orderByPriority',
      value: 'orderByValue',
    } as const;
    constraints.push(buildConstraint(type[spec.orderBy.kind], { kind: 'orderBy', spec: spec.orderBy }));
  }
  for (const bound of spec.bounds) {
    constraints.push(buildConstraint(bound.kind, { kind: 'bound', bound }));
  }
  if (spec.limit !== null) {
    constraints.push(
      buildConstraint(spec.limit.kind, { kind: 'limit', limitKind: spec.limit.kind, n: spec.limit.n }),
    );
  }
  return constraints;
}

async function replayRtdbQueryRead(
  sandbox: ReturnType<typeof initializeSandbox>,
  event: SandboxOperationEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  const path = event.path ?? '/';
  const prev = sandbox.currentUser;
  sandbox.currentUser = event.auth;
  try {
    const db = getDatabase(sandbox);
    await get(query(ref(db, path), ...constraintsOfSpec(event.request?.query as QuerySpec)));
  } catch (e) {
    divergences.push({
      kind: 'now-denied',
      path,
      method: event.method,
      reason: e instanceof Error ? e.message : String(e),
    });
  } finally {
    sandbox.currentUser = prev;
  }
}

async function replayRtdbAdminCommit(
  sandbox: ReturnType<typeof initializeSandbox>,
  commit: SandboxCommitEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  const db = getAdminDatabase(sandbox);
  await replayRtdbCommitWithDatabase(db, commit, divergences);
}

async function rewindRtdbCommits(
  adminDb: ReturnType<typeof getAdminDatabase>,
  commits: SandboxCommitEvent[],
): Promise<void> {
  for (const commit of [...commits].reverse()) {
    if (!commit.path) continue;
    const dbRef = ref(adminDb, commit.path);
    if (commit.method === 'setPriority') {
      await setPriority(dbRef, priorityDetail(commit, 'priorPriority'));
      continue;
    }
    await set(dbRef, commit.priorState ?? null);
    if (hasPriorityDetail(commit)) {
      await setPriority(dbRef, priorityDetail(commit, 'priorPriority'));
    }
  }
}

async function replayRtdbCommitWithDatabase(
  db: Database,
  commit: SandboxCommitEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  const path = commit.path ?? '/';
  const dbRef = ref(db, path);
  switch (commit.method) {
    case 'set':
      if (hasPriorityDetail(commit)) {
        await setWithPriority(dbRef, commit.data as never, priorityDetail(commit, 'priority'));
      } else {
        await set(dbRef, commit.data);
      }
      break;
    case 'setPriority':
      await setPriority(dbRef, priorityDetail(commit, 'priority'));
      break;
    case 'remove':
      await remove(dbRef);
      break;
    case 'update':
      if (!isJsonObject(commit.data)) {
        divergences.push({
          kind: 'unsupported',
          path,
          method: commit.method,
          reason: 'captured RTDB update commit did not contain an object patch.',
        });
        return;
      }
      await update(dbRef, commit.data);
      break;
    case 'transaction':
      await runTransaction(
        dbRef,
        () => commit.data as never,
        { applyLocally: false },
      );
      break;
    default:
      divergences.push({
        kind: 'unsupported',
        path,
        method: commit.method,
        reason: `RTDB replay does not support '${commit.method}' commits.`,
      });
  }
}

function hasPriorityDetail(commit: SandboxCommitEvent): boolean {
  return commit.detail !== undefined
    && Object.prototype.hasOwnProperty.call(commit.detail, 'priority');
}

function priorityDetail(
  commit: SandboxCommitEvent,
  field: 'priority' | 'priorPriority',
): string | number | null {
  const value = commit.detail?.[field];
  if (value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  throw new Error(`RTDB replay commit has invalid ${field} metadata.`);
}

function isRtdbCommit(event: SandboxEvent): event is SandboxCommitEvent {
  return event.kind === 'commit' && event.service === 'rtdb';
}

function collectStateDrift(
  expected: unknown,
  actual: unknown,
  path: string,
  out: RtdbReplayDivergence[],
): void {
  if (jsonValuesEqual(expected, actual)) return;
  if (!isJsonObject(expected) || !isJsonObject(actual)) {
    out.push({
      kind: 'state-drift',
      path,
      before: expected,
      after: actual,
    });
    return;
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    collectStateDrift(
      expected[key],
      actual[key],
      path === '/' ? `/${key}` : `${path}/${key}`,
      out,
    );
  }
}
