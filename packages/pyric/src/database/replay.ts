import { assertCompleteHistory } from '../sandbox/internal/history-integrity.js';
import {
  getClock,
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
import { resolveDatabaseInstance } from '../sandbox/internal/instances.js';

export interface RtdbReplayOptions {
  rules: { rules: Record<string, unknown> };
  capturedState?: unknown;
  /**
   * The instance to check, by name or database URL. Absent, an empty string,
   * or `default` is the default instance. Only the events that instance's
   * backend emitted replay, and they replay into the instance of the same
   * name in the replay sandbox; `capturedState` is that instance's state. An
   * event with no `instance` field is the default instance's, so a capture
   * recorded before events named their instance replays as it did before.
   *
   * Replay matches the name literally and does not know the project id, so
   * the project's default instance name (`<projectId>-default-rtdb`) selects
   * events stamped with that name, not the default instance's. A caller that
   * knows the project maps its default name to `undefined` first, as the host
   * resolves an operation's `instance`.
   */
  instance?: string;
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
  const target: ReplayTarget = { sandbox, instance: resolveDatabaseInstance(opts.instance)?.name };
  const db = getDatabase(sandbox, target.instance);
  const adminDb = getAdminDatabase(sandbox, target.instance);
  rtdbSandbox.setRules(db, opts.rules);

  const instanceEvents = events.filter((event) => instanceOf(event) === target.instance);
  const commits = instanceEvents.filter(isRtdbCommit);
  const divergences: RtdbReplayDivergence[] = [];
  let checkedEvents = 0;
  const hasCapturedState = opts.capturedState !== undefined;

  if (hasCapturedState) {
    rtdbSandbox.setData(adminDb, { '/': opts.capturedState });
    await rewindRtdbCommits(adminDb, commits);
  }

  for (const event of instanceEvents) {
    if (isAllowedQueryRead(event)) {
      checkedEvents += 1;
      await replayRtdbQueryRead(target, event, divergences);
      continue;
    }
    if (!isRtdbCommit(event)) continue;
    const commit = event;
    const path = commit.path ?? '/';
    const isAdmin = commit.detail?.admin === true;
    if (isAdmin) {
      await replayRtdbAdminCommit(target, commit, divergences);
      continue;
    }

    checkedEvents += 1;
    try {
      await replayRtdbAppCommit(target, commit, divergences);
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

/** The replay sandbox and the instance the replay runs in; `undefined` is the default instance. */
interface ReplayTarget {
  sandbox: Sandbox;
  instance: string | undefined;
}

/**
 * The instance an event names, or `undefined` for the default instance. An
 * event captured before events named their instance carries no field, so it
 * belongs to the default instance.
 */
function instanceOf(event: SandboxEvent): string | undefined {
  return 'instance' in event ? event.instance : undefined;
}

function syncReplayClock(sandbox: Sandbox, at: number | undefined): void {
  if (typeof at === 'number' && Number.isFinite(at)) {
    getClock(sandbox).set(at);
  }
}

async function replayRtdbAppCommit(
  { sandbox, instance }: ReplayTarget,
  commit: SandboxCommitEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  syncReplayClock(sandbox, commit.replay?.requestTime ?? commit.at);
  const prev = sandbox.currentUser;
  sandbox.currentUser = commit.auth;
  try {
    const db = getDatabase(sandbox, instance);
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
  { sandbox, instance }: ReplayTarget,
  event: SandboxOperationEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  syncReplayClock(sandbox, event.at);
  const path = event.path ?? '/';
  const prev = sandbox.currentUser;
  sandbox.currentUser = event.auth;
  try {
    const db = getDatabase(sandbox, instance);
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
  { sandbox, instance }: ReplayTarget,
  commit: SandboxCommitEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  syncReplayClock(sandbox, commit.replay?.requestTime ?? commit.at);
  const db = getAdminDatabase(sandbox, instance);
  await replayRtdbCommitWithDatabase(db, commit, divergences);
}

async function rewindRtdbCommits(
  adminDb: ReturnType<typeof getAdminDatabase>,
  commits: SandboxCommitEvent[],
): Promise<void> {
  for (const commit of [...commits].reverse()) {
    if (!commit.path) continue;
    const overwritten = overwrittenAncestorDetail(commit);
    if (overwritten !== null) {
      await set(ref(adminDb, overwritten.path), overwritten.state);
      continue;
    }
    const dbRef = ref(adminDb, commit.path);
    if (commit.method === 'setPriority') {
      await setPriority(dbRef, priorityDetail(commit, 'priorPriority'));
      continue;
    }
    if (hasPriorExportDetail(commit)) {
      await set(dbRef, commit.detail?.priorExport ?? null);
      continue;
    }
    await set(dbRef, commit.priorState ?? null);
    if (hasPriorPriorityDetail(commit)) {
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
    case 'set': {
      const priority = hasPriorityDetail(commit) ? priorityDetail(commit, 'priority') : null;
      if (priority !== null) {
        await setWithPriority(dbRef, commit.data as never, priority);
      } else {
        await set(dbRef, commit.data);
      }
      break;
    }
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

function hasPriorPriorityDetail(commit: SandboxCommitEvent): boolean {
  return commit.detail !== undefined
    && Object.prototype.hasOwnProperty.call(commit.detail, 'priorPriority');
}

function hasPriorExportDetail(commit: SandboxCommitEvent): boolean {
  return commit.detail !== undefined
    && Object.prototype.hasOwnProperty.call(commit.detail, 'priorExport');
}

function overwrittenAncestorDetail(
  commit: SandboxCommitEvent,
): { path: string; state: unknown } | null {
  const raw = commit.detail?.overwrittenAncestor;
  if (!isJsonObject(raw) || typeof raw.path !== 'string' || !Object.hasOwn(raw, 'state')) {
    return null;
  }
  return { path: raw.path, state: raw.state };
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

function isEmptyRoot(value: unknown): boolean {
  return value === null || (isJsonObject(value) && Object.keys(value).length === 0);
}

function collectStateDrift(
  expected: unknown,
  actual: unknown,
  path: string,
  out: RtdbReplayDivergence[],
): void {
  if (jsonValuesEqual(expected, actual)) return;
  if (path === '/' && isEmptyRoot(expected) && isEmptyRoot(actual)) return;
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
