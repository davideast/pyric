import {
  initializeSandbox,
  type Sandbox,
  type SandboxCommitEvent,
  type SandboxEvent,
} from '../sandbox/index.js';
import {
  getAdminDatabase,
  getDatabase,
  ref,
  remove,
  runTransaction,
  set,
  update,
  sandbox as rtdbSandbox,
} from './modular.js';

export interface RtdbReplayOptions {
  rules: { rules: Record<string, unknown> };
  capturedState?: unknown;
  databaseUrl?: string;
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

  for (const commit of commits) {
    const path = commit.path ?? '/';
    if (commit.detail?.admin === true) {
      await replayRtdbAdminCommit(sandbox, commit, divergences);
      continue;
    }

    checkedEvents += 1;
    try {
      await replayRtdbAppCommit(sandbox, commit, divergences);
    } catch (e) {
      divergences.push({
        kind: 'now-denied',
        path,
        method: commit.method,
        reason: e instanceof Error ? e.message : String(e),
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
    await set(ref(adminDb, commit.path), commit.priorState ?? null);
  }
}

async function replayRtdbCommitWithDatabase(
  db: ReturnType<typeof getDatabase>,
  commit: SandboxCommitEvent,
  divergences: RtdbReplayDivergence[],
): Promise<void> {
  const path = commit.path ?? '/';
  const dbRef = ref(db, path);
  switch (commit.method) {
    case 'set':
      await set(dbRef, commit.data);
      break;
    case 'remove':
      await remove(dbRef);
      break;
    case 'update':
      if (!isRecord(commit.data)) {
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

function isRtdbCommit(event: SandboxEvent): event is SandboxCommitEvent {
  return event.kind === 'commit' && event.service === 'rtdb';
}

function collectStateDrift(
  expected: unknown,
  actual: unknown,
  path: string,
  out: RtdbReplayDivergence[],
): void {
  if (deepEqual(expected, actual)) return;
  if (!isRecord(expected) || !isRecord(actual)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]));
}
