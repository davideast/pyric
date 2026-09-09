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
import { stripJsonComments } from '../../database/sandbox-controls.js';
import { getAdminStorageSandbox, replaceStorageRules } from '../../storage/internal.js';
import { Timestamp } from 'pyric/rules/internal';
import {
  applyFullState,
  captureFullState,
  type DatabaseRuleset,
  type FullSandboxState,
} from '../full-state.js';
import { initializeSandbox } from '../index.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import type { SandboxEvent, WriteSandboxEvent } from '../types/events.js';
import type { LocalSandbox } from '../types/service.js';
import { promoteFullState } from './promotion.js';
import { diffFullStates, type BranchDivergence } from './state-diff.js';

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
    parsed = JSON.parse(stripJsonComments(source));
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
export function apply(branch: Branch, events: readonly SandboxEvent[]): Branch {
  assertLive(branch);
  const env = getInternalEnv(branch.sandbox);
  const writes = events.filter((event): event is WriteSandboxEvent => event.kind === 'write');

  for (const write of writes) {
    const data = preResolutionDataFor(write, events) ?? write.data;
    const requestTime = new Timestamp(write.requestTime.seconds, write.requestTime.nanoseconds);

    if (write.autoId) {
      const collection = write.path.slice(0, write.path.lastIndexOf('/'));
      env.createWithAutoId(collection, (data ?? {}) as DocData, write.auth);
      continue;
    }

    try {
      env.execute(executionFor(write, data, requestTime));
    } catch {
      // A denied or failed re-issue surfaces later as state divergence in
      // diff(), so one bad write does not abort the rest of the stream.
    }
  }

  branch.events.push(...events);
  return branch;
}

/** One re-issued write, assembled before it crosses the environment boundary. */
function executionFor(
  write: WriteSandboxEvent,
  data: DocData | undefined,
  requestTime: Timestamp,
): {
  method: WriteSandboxEvent['method'];
  path: string;
  auth: WriteSandboxEvent['auth'];
  data?: DocData;
  requestTime: Timestamp;
} {
  const execution: {
    method: WriteSandboxEvent['method'];
    path: string;
    auth: WriteSandboxEvent['auth'];
    data?: DocData;
    requestTime: Timestamp;
  } = { method: write.method, path: write.path, auth: write.auth, requestTime };
  if (data !== undefined) execution.data = data;
  return execution;
}

/**
 * The pre-resolution payload for a write: the `request` event at or before it
 * on the same path carries `request.resourceData` with sentinels intact.
 * Mirrors the replay engine's own lookup.
 */
function preResolutionDataFor(
  write: WriteSandboxEvent,
  allEvents: readonly SandboxEvent[],
): DocData | undefined {
  const writeIndex = allEvents.indexOf(write);
  if (writeIndex < 0) return undefined;
  for (let index = writeIndex; index >= 0; index--) {
    const event = allEvents[index];
    if (!event || event.kind !== 'request') continue;
    if (event.path !== write.path) continue;
    return event.request?.resourceData as DocData | undefined;
  }
  return undefined;
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
 */
export async function promote(branch: Branch, target: LocalSandbox): Promise<void> {
  assertLive(branch);
  const rollback = await captureFullState(target);
  const current = await captureFullState(branch.sandbox);
  try {
    await promoteFullState(target, branch.base, current);
  } catch (error) {
    await applyFullState(target, rollback);
    throw error;
  }
  branch.discarded = true;
  branch.sandbox.dispose();
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
