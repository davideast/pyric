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
  getAdminDatabase,
  getDatabase,
  ref,
  remove,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  update,
  sandbox as rtdbSandbox,
  type Database,
} from './index.js';
import type { QuerySpec } from './internal/query-projection.js';
import { isJsonObject, jsonValuesEqual } from './sandbox/data-tree.js';
import { resolveDatabaseInstance } from '../sandbox/internal/instances.js';
import { getOrCreateBackend } from './sandbox/backend-for.js';
import type { RtdbBackend } from './sandbox/backend.js';

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

/**
 * A divergence replay found. `step` is the index, in `rtdbReplaySteps`, of the
 * captured step it came from; a `state-drift` has none.
 */
export type RtdbReplayDivergence = { step?: number } & (
  | {
      kind: 'now-denied';
      path?: string;
      method?: string;
      reason?: string;
    }
  | {
      kind: 'now-allowed';
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
    });

/**
 * One captured event of an instance, as replay judges it. Every engine that
 * checks a capture walks these in order, so they agree on which events carry
 * a claim the candidate rules must keep:
 *
 * - `app-commit`: a write an application user made and the rules allowed.
 * - `admin-commit`: an admin write; context, not checked.
 * - `allowed-read`: a `get` or listener attach the rules allowed.
 * - `denial`: an operation by an application user the rules denied.
 * - `allowed-registration`: an `onDisconnect` registration the rules allowed.
 */
export type RtdbReplayStep =
  | { kind: 'app-commit'; event: SandboxCommitEvent }
  | { kind: 'admin-commit'; event: SandboxCommitEvent }
  | { kind: 'allowed-read'; event: SandboxOperationEvent }
  | { kind: 'denial'; event: SandboxOperationEvent }
  | { kind: 'allowed-registration'; event: SandboxOperationEvent };

/** The captured events of `instance` (name or URL; absent is the default instance), in order, as replay judges them. */
export function rtdbReplaySteps(events: readonly SandboxEvent[], instance?: string): RtdbReplayStep[] {
  const name = resolveDatabaseInstance(instance)?.name;
  const steps: RtdbReplayStep[] = [];
  for (const event of events) {
    if (instanceOf(event) !== name) continue;
    if (isAllowedRead(event)) steps.push({ kind: 'allowed-read', event });
    else if (isAppDenial(event)) steps.push({ kind: 'denial', event });
    else if (isAllowedRegistration(event)) steps.push({ kind: 'allowed-registration', event });
    else if (isRtdbCommit(event)) {
      steps.push(event.detail?.admin === true ? { kind: 'admin-commit', event } : { kind: 'app-commit', event });
    }
  }
  return steps;
}

/**
 * The tree `instance` held when the session began: `capturedState`, the tree
 * the session left it with, with the session's commits rewound. Priorities the
 * rewind restores (a session write that replaced a prioritized node records
 * its prior priority) appear as `.priority` keys, the export format the
 * Realtime Database REST API reads; a prioritized leaf becomes
 * `{ ".value": v, ".priority": p }`. A priority the capture never saw is not
 * carried.
 */
export async function rewoundRtdbTree(
  events: readonly SandboxEvent[],
  capturedState: unknown,
  instance?: string,
): Promise<unknown> {
  const sandbox = initializeSandbox();
  const name = resolveDatabaseInstance(instance)?.name;
  const adminDb = getAdminDatabase(sandbox, name);
  rtdbSandbox.setData(adminDb, { '/': capturedState ?? null });
  const commits = events.filter((event): event is SandboxCommitEvent => instanceOf(event) === name && isRtdbCommit(event));
  await rewindRtdbCommits(adminDb, commits);
  const exported = getOrCreateBackend(sandbox, resolveDatabaseInstance(name)).exportPersistenceState() as {
    data?: unknown;
    priorities?: Record<string, string | number | null>;
  };
  return withExportedPriorities(exported.data ?? null, exported.priorities ?? {});
}

/** `tree` with each priority in `priorities` (by absolute path) set as a `.priority` key. */
function withExportedPriorities(tree: unknown, priorities: Record<string, string | number | null>): unknown {
  let out: unknown = structuredClone(tree);
  for (const [path, priority] of Object.entries(priorities)) {
    if (priority === null) continue;
    const segments = path.split('/').filter(Boolean);
    const attach = (node: unknown): unknown => {
      if (node === null || node === undefined) return node;
      if (isJsonObject(node)) return { ...node, '.priority': priority };
      return { '.value': node, '.priority': priority };
    };
    if (segments.length === 0) {
      out = attach(out);
      continue;
    }
    let parent: unknown = out;
    for (const segment of segments.slice(0, -1)) {
      parent = isJsonObject(parent) ? parent[segment] : undefined;
    }
    const last = segments.at(-1)!;
    if (isJsonObject(parent) && last in parent) (parent as Record<string, unknown>)[last] = attach(parent[last]);
  }
  return out;
}

/** The paths where `actual` differs from `expected`, as `state-drift` divergences. */
export function rtdbStateDrift(expected: unknown, actual: unknown): RtdbReplayDivergence[] {
  const out: RtdbReplayDivergence[] = [];
  collectStateDrift(expected, actual, '/', out);
  return out;
}

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

  const steps = rtdbReplaySteps(events, target.instance);
  const divergences: RtdbReplayDivergence[] = [];
  let checkedEvents = 0;
  const hasCapturedState = opts.capturedState !== undefined;

  if (hasCapturedState) {
    // Rewound in this sandbox, not through `rewoundRtdbTree`: priorities live
    // in the backend's metadata, and no tree export carries them.
    rtdbSandbox.setData(adminDb, { '/': opts.capturedState });
    await rewindRtdbCommits(adminDb, steps.flatMap((step) => (step.kind === 'app-commit' || step.kind === 'admin-commit' ? [step.event] : [])));
  }

  for (const [index, step] of steps.entries()) {
    const before = divergences.length;
    await replayStep(target, step, divergences, () => { checkedEvents += 1; });
    // Each divergence names the replay step it came from, so engines compare step for step.
    for (const divergence of divergences.slice(before)) divergence.step = index;
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

/** Replay one step under the candidate rules; `checked` counts a step that carries a claim. */
async function replayStep(
  target: ReplayTarget,
  step: RtdbReplayStep,
  divergences: RtdbReplayDivergence[],
  checked: () => void,
): Promise<void> {
  if (step.kind === 'admin-commit') {
    await replayRtdbAdminCommit(target, step.event, divergences);
    return;
  }
  checked();
  if (step.kind === 'allowed-read') {
    await replayRtdbRead(target, step.event, divergences);
  } else if (step.kind === 'denial') {
    checkRtdbDecision(target, step.event, 'deny', divergences);
  } else if (step.kind === 'allowed-registration') {
    checkRtdbDecision(target, step.event, 'allow', divergences);
  } else {
    const commit = step.event;
    try {
      await replayRtdbAppCommit(target, commit, divergences);
    } catch (e) {
      divergences.push({
        kind: 'now-denied',
        path: commit.path ?? '/',
        method: commit.method,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
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
 * A read by an application user that was allowed: a one-shot `get`, or the
 * attach of a listener, whose first read the same `.read` rules decide. The
 * candidate rules must keep allowing it: its `.read` rules, and the `query.*`
 * rule expressions when it carried a query. An admin read and a denied read
 * carry no claim the candidate rules must keep.
 */
function isAllowedRead(event: SandboxEvent): event is SandboxOperationEvent {
  return event.kind === 'operation'
    && event.service === 'rtdb'
    && (event.method === 'get' || (event.method === 'listen' && event.origin === 'listener'))
    && event.origin !== 'admin'
    && event.result === 'allow';
}

/**
 * Decide an allowed read again under the candidate rules, by its `.read`
 * rules and `query.*` expressions alone, against the replay tree at that
 * point. The read is not run: a listener on an unindexed query only warns,
 * where running it as a one-shot query would refuse it for the index.
 */
async function replayRtdbRead(
  { sandbox, instance }: ReplayTarget,
  event: SandboxOperationEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  syncReplayClock(sandbox, event.at);
  const path = event.path ?? '/';
  const backend = getOrCreateBackend(sandbox, resolveDatabaseInstance(instance));
  try {
    backend.validateRead(event.auth, path, event.request?.query as QuerySpec | undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const denied = (e as { code?: unknown }).code === 'PERMISSION_DENIED';
    divergences.push(denied
      ? { kind: 'now-denied', path, method: event.method, reason }
      : { kind: 'unsupported', path, method: event.method, reason });
  }
}

/**
 * An operation by an application user that the rules denied. A candidate
 * ruleset that allows it has opened access the captured rules kept closed.
 */
function isAppDenial(event: SandboxEvent): event is SandboxOperationEvent {
  return event.kind === 'operation'
    && event.service === 'rtdb'
    && event.origin !== 'admin'
    && event.result === 'deny'
    && !isRevocation(event);
}

/**
 * A listener the rules stopped allowing after it attached, because of a write
 * or a rules change. It is a consequence, not a request: its attach was
 * checked as an allowed read, and the write that caused it is checked itself.
 */
function isRevocation(event: SandboxOperationEvent): boolean {
  return (event.detail as { revoked?: unknown } | undefined)?.revoked === true;
}

/**
 * An `onDisconnect` registration by an application user that the rules
 * allowed. Production decides a registration when it is made, so the
 * candidate rules must keep allowing it at that point in the session.
 */
function isAllowedRegistration(event: SandboxEvent): event is SandboxOperationEvent {
  return event.kind === 'operation'
    && event.service === 'rtdb'
    && event.origin !== 'admin'
    && event.result === 'allow'
    && typeof event.method === 'string'
    && event.method.startsWith('onDisconnect.');
}

/**
 * The backend check that decides a captured operation again under the
 * candidate rules, against the replay tree as it stands at that point in the
 * session, without writing or emitting an event; or the reason it cannot be
 * decided from what the capture holds.
 */
function decisionCheck(backend: RtdbBackend, event: SandboxOperationEvent): (() => void) | string {
  const path = event.path ?? '/';
  const data = event.request?.data;
  const detail = (event.detail ?? {}) as { patch?: unknown; rootPath?: unknown; priority?: unknown };
  switch (event.method) {
    case 'get':
    case 'listen':
      return () => backend.validateRead(event.auth, path, event.request?.query as QuerySpec | undefined);
    case 'set':
    case 'transaction':
      return () => backend.validateSet(event.auth, path, data ?? null, (detail.priority ?? null) as string | number | null);
    case 'remove':
      return () => backend.validateSet(event.auth, path, null);
    case 'update':
      if (!isJsonObject(detail.patch) || typeof detail.rootPath !== 'string') {
        return 'the capture records only the denied path of this update, not the paths written with it, so the update cannot be rebuilt.';
      }
      return () => backend.validateUpdate(event.auth, detail.rootPath as string, detail.patch as Record<string, unknown>);
    case 'setPriority':
      return () => backend.validatePriority(event.auth, path, data as string | number | null);
    case 'onDisconnect.set':
      return () => backend.validateSet(event.auth, path, data ?? null, (detail.priority ?? null) as string | number | null);
    case 'onDisconnect.remove':
      return () => backend.validateSet(event.auth, path, null);
    case 'onDisconnect.update':
      if (!isJsonObject(data)) return 'the captured onDisconnect update did not contain an object patch.';
      return () => backend.validateUpdate(event.auth, path, data);
    default:
      return `RTDB replay does not check '${event.method}' operations.`;
  }
}

/**
 * Decide a captured operation again under the candidate rules. `captured` is
 * the verdict the session's rules gave: a denial the candidate rules allow is
 * `now-allowed`, an allowed registration they deny is `now-denied`.
 */
function checkRtdbDecision(
  { sandbox, instance }: ReplayTarget,
  event: SandboxOperationEvent,
  captured: 'allow' | 'deny',
  divergences: RtdbReplayDivergence[],
): void {
  syncReplayClock(sandbox, event.at);
  const path = event.path ?? '/';
  const check = decisionCheck(getOrCreateBackend(sandbox, resolveDatabaseInstance(instance)), event);
  if (typeof check === 'string') {
    divergences.push({ kind: 'unsupported', path, method: event.method, reason: check });
    return;
  }
  let allowed = true;
  let reason: string | undefined;
  try {
    check();
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
    if ((e as { code?: unknown }).code !== 'PERMISSION_DENIED') {
      divergences.push({ kind: 'unsupported', path, method: event.method, reason });
      return;
    }
    allowed = false;
  }
  if (captured === 'deny' && allowed) {
    divergences.push({
      kind: 'now-allowed',
      path,
      method: event.method,
      reason: 'the captured rules denied this operation; the candidate rules allow it.',
    });
  } else if (captured === 'allow' && !allowed) {
    divergences.push({ kind: 'now-denied', path, method: event.method, reason });
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
