/**
 * Branches: fork, apply, diff, promote, discard.
 *
 * A branch is an isolated sandbox seeded from a {@link FullSandboxState}, plus
 * the events applied to it since the fork. The mental model:
 *
 *   const branch = await fork(await captureFullState(live), candidateRules);
 *   apply(branch, agentPlanEvents);
 *   const changes = await diff(branch, live);
 *   await promote(branch, live);
 *   // ...or...
 *   discard(branch);
 *
 * What a branch carries. Everything the sandbox holds: Firestore documents,
 * the Realtime Database tree, Storage objects with their bytes and metadata,
 * auth accounts, and the three rule sources. A branch that silently held only
 * Firestore would report a clean diff over state it never looked at, so the
 * fork seeds from a full state and the promotion lands one.
 *
 * Why these are asynchronous. Storage objects live behind an asynchronous
 * backend, so any operation that reads or writes the whole sandbox is
 * asynchronous too. `apply` and `discard` touch neither, so they stay
 * synchronous.
 *
 * Diff honesty. Every difference is a `real-divergence`. A branch carries no
 * captured write metadata that could license sentinel or auto-id drift, so
 * that is the correct classification for state against state. Each record also
 * names its service and the path or uid it concerns.
 *
 * Promotion honesty. A promotion writes the delta between the state the branch
 * forked from and the state it holds now, so state on the target that the
 * branch never touched survives. It is atomic from the caller's point of view:
 * the target's full state is captured first, and any throw restores that
 * capture, rethrows the original error, and leaves the branch undiscarded.
 */

import { getOrCreateBackend } from '../../database/sandbox/backend-for.js';
import type { JsonValue } from '../../database/sandbox/data-tree.js';
import type { Priority } from '../../database/sandbox/query.js';
import { toStrictRulesJson } from '@pyric/rules/internal/rtdb';
import { getAdminStorageSandbox, replaceStorageRules } from '../../storage/internal.js';
import { Timestamp } from 'pyric/rules/internal';
import type { BatchOperationInput } from '../../firestore/sandbox/writes.js';
import { getClock } from '../clock.js';
import {
  applyFullState,
  captureFullState,
  type DatabaseRuleset,
  type FullSandboxState,
} from '../full-state.js';
import { databaseInstanceNamed } from '../internal/instances.js';
import { initializeSandbox } from '../index.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import type { SandboxCommitEvent, SandboxEvent, WriteSandboxEvent } from '../types/events.js';
import type { LocalSandbox } from '../types/service.js';
import { promoteFullState } from './promotion.js';
import { diffFullStates, type BranchDivergence } from './state-diff.js';
import { batchMethodOf, resolveReplayWriteData } from '../replay/index.js';

type DocData = Record<string, unknown>;

/**
 * Rule sources a fork installs on the branch in place of the ones the state
 * carries. Each is independent: naming one replaces that service's rules and
 * leaves the other two as the forked state had them.
 */
export interface BranchCandidateRules {
  /** Firestore Security Rules source to run the branch under. */
  firestore?: string;
  /** Realtime Database ruleset to run the branch under. */
  database?: DatabaseRuleset;
  /** Storage Security Rules source to run the branch under. */
  storage?: string;
}

/**
 * An isolated experiment seeded from a {@link FullSandboxState}.
 *
 * A branch owns its own {@link LocalSandbox}, fully isolated from the source:
 * separate environment, separate event history, separate service backends.
 */
export interface Branch {
  /** The branch's own sandbox. Read it directly, or through `captureFullState`. */
  readonly sandbox: LocalSandbox;
  /** The candidate rules the fork installed, so a store can rebuild the branch. */
  readonly candidateRules: BranchCandidateRules;
  /** The full state this branch was forked from. The baseline a promotion is a delta against. */
  readonly base: FullSandboxState;
  /** Events applied since the fork, in order. */
  readonly events: SandboxEvent[];
  /** Set by {@link discard} and by a completed {@link promote}. */
  discarded: boolean;
}

/** What a branch can be compared against: a live sandbox, or a captured state. */
export type DiffTarget = LocalSandbox | FullSandboxState;

let nextBranchStorage = 1;

/**
 * Open the branch's Storage service on a database of its own.
 *
 * Storage durability is keyed by database name, not by sandbox, so two
 * sandboxes that open the default database share one bucket. A branch that
 * shared its bucket with the sandbox it forked from would leak every object it
 * uploaded straight onto live, so the fork pins a name no other sandbox uses
 * before anything reaches Storage. Every later reach resolves the service this
 * call opened, because the service is cached per sandbox.
 */
function isolateBranchStorage(sandbox: LocalSandbox): void {
  const suffix = `${nextBranchStorage++}-${Math.random().toString(36).slice(2, 10)}`;
  getAdminStorageSandbox(sandbox, { dbName: `pyric-branch-storage:${suffix}` });
}

/** A candidate rules argument in its normalized form. */
function normalizeCandidateRules(
  candidate: string | BranchCandidateRules | undefined,
): BranchCandidateRules {
  if (candidate === undefined) return {};
  if (typeof candidate !== 'string') return candidate;
  if (candidate === '') return {};
  const asDatabaseRuleset = parseDatabaseRuleset(candidate);
  if (asDatabaseRuleset !== null) return { database: asDatabaseRuleset };
  return { firestore: candidate };
}

/**
 * One rules string read as a Realtime Database ruleset, or null when it is not
 * one. A Realtime Database ruleset is JSON with a `rules` key, which no
 * Firestore or Storage rules source can be, so the two are told apart by
 * parsing rather than by asking the caller which they meant.
 */
function parseDatabaseRuleset(source: string): DatabaseRuleset | null {
  if (!source.trim().startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toStrictRulesJson(source));
  } catch {
    return null;
  }
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject) return null;
  const candidate = parsed as Record<string, unknown>;
  if (!('rules' in candidate)) return null;
  return candidate as unknown as DatabaseRuleset;
}

/** Install whichever candidate rule sources the fork was given. */
async function installCandidateRules(
  sandbox: LocalSandbox,
  candidate: BranchCandidateRules,
): Promise<void> {
  if (candidate.firestore !== undefined) {
    getInternalEnv(sandbox).deployRules(candidate.firestore);
  }
  if (candidate.database !== undefined) {
    getOrCreateBackend(sandbox).setRules(structuredClone(candidate.database));
  }
  if (candidate.storage !== undefined) {
    await replaceStorageRules(sandbox, candidate.storage);
  }
}

/**
 * Fork a new branch from a captured full state.
 *
 * The branch's sandbox reads identically to the state it was forked from in
 * every service, and writes on it never reach the source.
 *
 * @param base      The baseline, typically `await captureFullState(live)`.
 * @param candidate Rule sources to run the branch under in place of the
 *                  baseline's. A string is read as a Realtime Database ruleset
 *                  when it parses as JSON with a `rules` key, and as Firestore
 *                  rules otherwise. An object names each service explicitly.
 */
export async function fork(
  base: FullSandboxState,
  candidate?: string | BranchCandidateRules,
): Promise<Branch> {
  const candidateRules = normalizeCandidateRules(candidate);
  const sandbox = initializeSandbox();
  isolateBranchStorage(sandbox);
  await applyFullState(sandbox, base);
  await installCandidateRules(sandbox, candidateRules);
  return { sandbox, candidateRules, base, events: [], discarded: false };
}

/**
 * Apply a stream of events to a branch by re-issuing their writes against the
 * branch's current state.
 *
 * This is the per-write re-issue logic `replay()` runs (filter to writes,
 * honour `autoId` and the pinned `requestTime`, prefer the pre-resolution
 * `request.resourceData` so sentinels re-resolve), applied incrementally on
 * the branch's existing environment rather than on a fresh empty sandbox. The
 * applied events are folded into `branch.events` so a store can rebuild the
 * branch from its base and its log.
 *
 * @returns the same branch, mutated in place, for chaining.
 */
type ReplayableBranchEvent = WriteSandboxEvent | (SandboxCommitEvent & { service: 'rtdb' });

function isReplayableBranchEvent(event: SandboxEvent): event is ReplayableBranchEvent {
  return event.kind === 'write' || (event.kind === 'commit' && event.service === 'rtdb');
}

export function apply(branch: Branch, events: readonly SandboxEvent[]): Branch {
  assertLive(branch);
  const env = getInternalEnv(branch.sandbox);
  const clock = getClock(branch.sandbox);
  const priorClock = clock.capture();
  let clockPinned = false;
  const replayable = events.filter(isReplayableBranchEvent);
  const consumedRequestIndices = new Set<number>();
  const pathAliases = new Map<string, string>();
  const remap = (path: string): string => {
    for (const [originalPath, replayedPath] of pathAliases) {
      if (path === originalPath) return replayedPath;
      if (path.startsWith(`${originalPath}/`)) {
        return replayedPath + path.slice(originalPath.length);
      }
    }
    return path;
  };
  const pinClockMs = (ms: number): void => {
    clock.set(ms);
    clockPinned = true;
  };
  const pinClockTo = (write: WriteSandboxEvent): void => {
    pinClockMs(write.requestTime.seconds * 1000 + Math.floor(write.requestTime.nanoseconds / 1e6));
  };
  const dataFor = (write: WriteSandboxEvent): DocData | undefined =>
    resolveReplayWriteData(write, events, consumedRequestIndices);

  try {
    for (let index = 0; index < replayable.length;) {
      const current = replayable[index]!;
      if (current.kind === 'commit') {
        replayRtdbCommit(branch.sandbox, current, pinClockMs);
        index += 1;
        continue;
      }

      const write = current;
      const group = groupAt(replayable, index);
      if (group.length > 0) {
        pinClockTo(write);
        const existsInGroup = new Map<string, boolean>();
        const operations: BatchOperationInput[] = group.map((event) => {
          const targetPath = remap(event.path);
          const method = batchMethodOf(event, targetPath, existsInGroup);
          const operation: BatchOperationInput = { method, path: targetPath };
          if (event.method !== 'delete') {
            const data = dataFor(event);
            if (data !== undefined) operation.data = data;
          }
          if (event.merge !== undefined) operation.merge = event.merge;
          return operation;
        });
        try {
          env.batch(operations, group[0]!.auth, group[0]!.detail?.admin === true);
        } catch {
          // A denied or failed batch surfaces later as state divergence in diff().
        }
        index += group.length;
        continue;
      }
      index += 1;

      const data = dataFor(write);
      const requestTime = new Timestamp(write.requestTime.seconds, write.requestTime.nanoseconds);
      const bypassRules = write.detail?.admin === true;

      if (write.autoId) {
        const targetPath = remap(write.path);
        pinClockTo(write);
        if (!(targetPath in env.snapshot())) {
          try {
            env.execute(executionFor(write, targetPath, data, requestTime));
          } catch {
            // Keep applying subsequent writes so diff() surfaces the divergence.
          }
          continue;
        }
        const collection = targetPath.slice(0, targetPath.lastIndexOf('/'));
        try {
          const { path: mintedPath, result } = env.createWithAutoId(
            collection,
            (data ?? {}) as DocData,
            write.auth,
            bypassRules,
          );
          if (result.allowed) {
            pathAliases.set(write.path, mintedPath);
          }
        } catch {
          // Keep applying subsequent writes so diff() surfaces the divergence.
        }
        continue;
      }

      try {
        env.execute(executionFor(write, remap(write.path), data, requestTime));
      } catch {
        // A denied or failed re-issue surfaces later as state divergence in
        // diff(), so one bad write does not abort the rest of the stream.
      }
    }
  } finally {
    if (clockPinned) clock.restore(priorClock);
  }

  branch.events.push(...events);
  return branch;
}

/** Replay one committed Realtime Database mutation against the branch's active rules and clock. */
function replayRtdbCommit(
  sandbox: LocalSandbox,
  commit: SandboxCommitEvent & { service: 'rtdb' },
  pinClockMs: (ms: number) => void,
): void {
  const instance = commit.instance === undefined
    ? undefined
    : databaseInstanceNamed(commit.instance);
  const backend = getOrCreateBackend(sandbox, instance);
  const requestTimeMs = commit.replay?.requestTime ?? commit.at;
  if (typeof requestTimeMs === 'number' && Number.isFinite(requestTimeMs)) {
    pinClockMs(requestTimeMs);
  }
  const rawPath = commit.path ?? '/';
  const path = rawPath === '' || rawPath === '/' ? '/' : rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const isAdmin = commit.detail?.admin === true;

  try {
    if (commit.method === 'remove') {
      if (isAdmin) backend.adminRemove(path);
      else backend.remove(commit.auth, path);
      return;
    }
    if (commit.method === 'update') {
      const patch = structuredClone((commit.data ?? {}) as Record<string, JsonValue>);
      if (isAdmin) backend.adminUpdate(path, patch);
      else backend.update(commit.auth, path, patch);
      return;
    }
    if (commit.method === 'setPriority') {
      const priority = structuredClone((commit.data ?? null) as Priority);
      if (isAdmin) backend.adminSetPriority(path, priority);
      else backend.setPriority(commit.auth, path, priority);
      return;
    }
    if (commit.method === 'transaction') {
      const proposed = structuredClone((commit.data ?? null) as JsonValue);
      backend.runTransaction(commit.auth, path, () => proposed, isAdmin ? { admin: true } : undefined);
      return;
    }
    if (commit.method === 'set') {
      const payload = structuredClone((commit.data ?? null) as JsonValue);
      const carriesInlinePriority =
        payload !== null && typeof payload === 'object' && !Array.isArray(payload) && '.priority' in payload;
      const detailPriority = commit.detail?.priority;
      const hasExplicitPriority =
        !carriesInlinePriority && (typeof detailPriority === 'string' || typeof detailPriority === 'number');
      if (hasExplicitPriority) {
        if (isAdmin) backend.adminSetWithPriority(path, payload, detailPriority);
        else backend.setWithPriority(commit.auth, path, payload, detailPriority);
        return;
      }
      if (isAdmin) backend.adminSet(path, payload);
      else backend.set(commit.auth, path, payload);
    }
  } catch {
    // A denied or failed re-issue surfaces later as state divergence in diff().
  }
}

/** The writes of the batch or transaction starting at `index`, or `[]` when single. */
function groupAt(events: readonly ReplayableBranchEvent[], index: number): WriteSandboxEvent[] {
  const first = events[index];
  if (first === undefined || first.kind !== 'write' || first.groupId === undefined) return [];
  const groupId = first.groupId;
  const group: WriteSandboxEvent[] = [];
  for (let at = index; at < events.length; at++) {
    const entry = events[at]!;
    if (entry.kind !== 'write' || entry.groupId !== groupId) break;
    group.push(entry);
  }
  return group;
}

/** One re-issued write, assembled before it crosses the environment boundary. */
function executionFor(
  write: WriteSandboxEvent,
  path: string,
  data: DocData | undefined,
  requestTime: Timestamp,
): {
  method: WriteSandboxEvent['method'];
  path: string;
  auth: WriteSandboxEvent['auth'];
  data?: DocData;
  merge?: WriteSandboxEvent['merge'];
  bypassRules?: boolean;
  requestTime: Timestamp;
} {
  const method: WriteSandboxEvent['method'] =
    write.method === 'update' && write.updateMask === undefined && write.merge === undefined
      ? 'set'
      : write.method;
  const execution: {
    method: WriteSandboxEvent['method'];
    path: string;
    auth: WriteSandboxEvent['auth'];
    data?: DocData;
    merge?: WriteSandboxEvent['merge'];
    bypassRules?: boolean;
    requestTime: Timestamp;
  } = { method, path, auth: write.auth, requestTime };
  if (data !== undefined) execution.data = data;
  if (write.merge !== undefined) execution.merge = write.merge;
  if (write.detail?.admin === true) execution.bypassRules = true;
  return execution;
}

/**
 * Every difference between a branch's current state and a reference, across
 * every service. Each record names its service and the path or uid it
 * concerns, with the reference's value as `before` and the branch's as
 * `after`.
 *
 * @param branch The experiment.
 * @param target A live sandbox, or a state captured from one.
 */
export async function diff(branch: Branch, target: DiffTarget): Promise<BranchDivergence[]> {
  assertLive(branch);
  const reference = await fullStateOf(target);
  const current = await captureFullState(branch.sandbox);
  return diffFullStates(reference, current);
}

/**
 * Land a branch's changes on a target, across every service.
 *
 * Atomic from the caller's point of view: the target's full state is captured
 * before the first write, and any throw restores that capture, rethrows the
 * original error, and leaves the branch undiscarded so the caller can inspect
 * or retry it. On success the branch is spent and its sandbox is disposed.
 *
 * When the restore itself throws the target is not atomic any more, and the
 * error says so: it carries the promotion's message first and the restore's
 * after it, because a caller reading it needs to know both what failed and
 * that the target still holds part of the change.
 */
export async function promote(branch: Branch, target: LocalSandbox): Promise<void> {
  assertLive(branch);
  const rollback = await captureFullState(target);
  const current = await captureFullState(branch.sandbox);
  try {
    await promoteFullState(target, branch.base, current);
  } catch (error) {
    await rollBackTo(target, rollback, error);
  }
  branch.discarded = true;
  branch.sandbox.dispose();
}

/**
 * Put the target back to the state the promotion started from, then rethrow.
 *
 * A restore that throws leaves the target part way through a partial
 * promotion, which is the worst state to be told nothing about. The error
 * raised carries both messages, the write that failed first, because that is
 * the one that says what the caller was trying to do; the restore's message
 * says how much of it is still there.
 */
async function rollBackTo(
  target: LocalSandbox,
  rollback: FullSandboxState,
  cause: unknown,
): Promise<never> {
  try {
    await applyFullState(target, rollback);
  } catch (restoreError) {
    throw new Error(
      `Promotion failed and the target could not be restored. The promotion failed with: ${messageOf(cause)}. The restore then failed with: ${messageOf(restoreError)}. The target holds a partly promoted state.`,
      { cause },
    );
  }
  throw cause;
}

/** One thrown value as a sentence, whether or not it was an Error. */
function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}

/**
 * Discard a branch: drop its sandbox and mark it spent. The target is never
 * touched, because nothing was promoted. Idempotent.
 */
export function discard(branch: Branch): void {
  if (branch.discarded) return;
  branch.discarded = true;
  branch.sandbox.dispose();
}

function assertLive(branch: Branch): void {
  if (branch.discarded) {
    throw new Error('Branch has been discarded or promoted; create a new fork.');
  }
}

/** The full state behind a diff target, captured when the target is a sandbox. */
async function fullStateOf(target: DiffTarget): Promise<FullSandboxState> {
  if (isSandbox(target)) return captureFullState(target);
  return target;
}

function isSandbox(target: DiffTarget): target is LocalSandbox {
  return typeof (target as LocalSandbox).snapshot === 'function';
}
