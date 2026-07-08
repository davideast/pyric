/**
 * Branches — a fork / apply / diff / promote / discard primitive built
 * **on top of** the existing `snapshot()` + `replay()` surface. Nothing
 * here re-implements those; a branch is an in-memory sandbox seeded from
 * a {@link SandboxSnapshot}, with `apply` delegating to `replay()` and
 * `diff` reusing the replay engine's structural divergence classifier.
 *
 * Mental model (the Pyric Studio "experiment" primitive — see
 * the design rationale):
 *
 *   const branch = fork(live.snapshot(), rules);   // isolated copy
 *   apply(branch, agentPlanEvents);                // re-issue writes
 *   const changes = diff(branch, live);            // what changed vs live
 *   promote(branch, live);   // land the branch's mutations on live
 *   // ...or...
 *   discard(branch);         // drop it; live is untouched
 *
 * This is the substrate for Studio's agent dry-run → accept/reject
 * (A1), rules-failure "re-run against an edited ruleset" (F4), and
 * time-travel (A2). Each of those wants: an isolated copy of current
 * state, a way to play hypothetical writes against it, a structural
 * diff, and a commit/rollback gate.
 *
 * Granularity / honesty notes:
 *   - `fork` rehydrates **Firestore** state from the snapshot (the
 *     `firestore` key) plus rules. Per-service state in
 *     `snapshot.services` (auth users, etc.) is NOT rehydrated here —
 *     a fresh fork has no registered persistable services to restore
 *     into, mirroring how persistence skips unregistered services. If a
 *     consumer needs auth-in-a-branch it can register services on the
 *     branch sandbox and restore them; that's out of scope for v1.
 *   - `diff` reuses the replay engine's doc-level + field-level walk
 *     (`Divergence`). Without captured write metadata it can't license
 *     sentinel/auto-id drift, so every field difference surfaces as
 *     `real-divergence` — which is the correct, honest classification
 *     for "branch state vs live state" (there are no replayed sentinels
 *     to reconcile). Doc add/remove surface as presence divergences.
 *   - `promote` re-issues the branch's accumulated write events onto the
 *     target via `replay`'s machinery, then copies the resulting docs
 *     onto the target through the admin plane. It applies *mutations*
 *     (added/changed/removed docs), not a blind whole-snapshot replace —
 *     docs the branch never touched are left alone on the target.
 */

import {
  initializeSandbox,
  type Divergence,
  type Sandbox,
  type SandboxEvent,
  type SandboxSnapshot,
  type WriteSandboxEvent,
} from '../index.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import { Timestamp } from 'pyric/rules';

type DocData = Record<string, unknown>;

/**
 * An isolated, in-memory experiment seeded from a {@link SandboxSnapshot}.
 *
 * A branch owns its own {@link Sandbox} (fully isolated from the source —
 * separate `LocalEnvironment`, separate event history) plus the
 * accumulated {@link SandboxEvent}s applied to it via {@link apply}. The
 * applied events are what {@link promote} replays onto the target.
 */
export interface Branch {
  /** The branch's own sandbox. Inspect it directly (`branch.sandbox.snapshot()`)
   *  or read docs via `branch.sandbox.admin.getDocument(path)`. */
  readonly sandbox: Sandbox;
  /** Rules the branch was forked with — carried so {@link promote} can
   *  re-seed a replay target identically. */
  readonly rules: string;
  /** The snapshot this branch was forked from. Retained so {@link diff}
   *  and {@link promote} can reason about the baseline. */
  readonly base: SandboxSnapshot;
  /** Write/op events applied to this branch since fork, in order. These
   *  are replayed onto the target by {@link promote}. */
  readonly events: SandboxEvent[];
  /** Flipped by {@link discard}; subsequent {@link apply}/{@link promote}
   *  calls throw. */
  discarded: boolean;
}

/** A reference to diff a branch against: a live sandbox or a bare snapshot. */
export type DiffTarget = Sandbox | SandboxSnapshot;

/**
 * Fork a new branch from a snapshot.
 *
 * Seeds a fresh sandbox with `rules` and the snapshot's Firestore docs
 * (the same `seed({ rules, documents })` path replay uses to stand up a
 * clean environment). The branch is fully isolated: writes on it never
 * touch the source sandbox.
 *
 * @param snapshot Baseline state — typically `liveSandbox.snapshot()`.
 * @param rules    Rules source for the branch. Pass the live rules to
 *                 reproduce production behaviour, or an *edited* ruleset
 *                 to test a rules change in isolation (Studio F4).
 */
export function fork(snapshot: SandboxSnapshot, rules = ''): Branch {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  // Copy-on-write fork: the branch reads `snapshot.firestore` as an immutable
  // base (no clone, O(1)) and lands its own writes in an overlay. The snapshot
  // is a stable, branch-owned object the live sandbox never mutates, so the
  // branch stays isolated from later live writes.
  env.seed({ rules, baseDocuments: snapshot.firestore });
  return {
    sandbox,
    rules,
    base: snapshot,
    events: [],
    discarded: false,
  };
}

/**
 * Apply a stream of events to a branch by re-issuing their writes against
 * the branch's CURRENT state.
 *
 * This is the same per-write re-issue logic `replay()` runs (filter to
 * `kind: 'write'`, honour `autoId` / pinned `requestTime`, prefer the
 * pre-resolution `request.resourceData` so sentinels re-resolve), but
 * applied *incrementally* on the branch's existing env rather than on a
 * fresh empty sandbox — so it composes over base docs (e.g. an `update`
 * lands on a doc the snapshot seeded) and accumulates across multiple
 * `apply` calls. The applied events are folded into `branch.events` so
 * {@link promote} can reproduce the same sequence on the target.
 *
 * @returns the same branch (mutated in place) for chaining.
 */
export function apply(branch: Branch, events: readonly SandboxEvent[]): Branch {
  assertLive(branch);
  const env = getInternalEnv(branch.sandbox);
  const writes = events.filter((e): e is WriteSandboxEvent => e.kind === 'write');

  for (const wEv of writes) {
    // Prefer the paired request event's pre-resolution payload (sentinels
    // intact); fall back to the write's post-resolution `data`.
    const data = preResolutionDataFor(wEv, events) ?? wEv.data;
    const requestTime = new Timestamp(wEv.requestTime.seconds, wEv.requestTime.nanoseconds);

    if (wEv.autoId) {
      const collection = wEv.path.slice(0, wEv.path.lastIndexOf('/'));
      env.createWithAutoId(collection, (data ?? {}) as DocData, wEv.auth);
      continue;
    }

    try {
      env.execute({
        method: wEv.method,
        path: wEv.path,
        auth: wEv.auth,
        ...(data !== undefined ? { data: data as DocData } : {}),
        requestTime,
      });
    } catch {
      // A denied/failed re-issue surfaces later as state divergence in
      // diff(); keep going so one bad write doesn't abort the rest.
    }
  }

  branch.events.push(...events);
  return branch;
}

/**
 * Best-effort pre-resolution payload for a write — the `request` event at
 * or before it (same path) carries `request.resourceData` with sentinels
 * intact. Mirrors the replay engine's `preResolutionDataFor`.
 */
function preResolutionDataFor(
  wEv: WriteSandboxEvent,
  allEvents: readonly SandboxEvent[],
): DocData | undefined {
  const wIdx = allEvents.indexOf(wEv);
  if (wIdx < 0) return undefined;
  for (let i = wIdx; i >= 0; i--) {
    const e = allEvents[i];
    if (!e || e.kind !== 'request') continue;
    if (e.path !== wEv.path) continue;
    return e.request?.resourceData as DocData | undefined;
  }
  return undefined;
}

/**
 * Structural diff of a branch's current state against a reference.
 *
 * Reuses the replay engine's `Divergence` result type and mirrors its
 * doc-level + field-level walk (see {@link diffDocSets}). With no captured
 * write metadata in play, differences surface as `real-divergence`
 * (field/doc changed) — the honest classification for "branch vs live".
 * Added/removed docs surface as presence divergences (one side
 * `undefined`).
 *
 * @param branch The experiment.
 * @param target Live sandbox or a snapshot to compare against.
 */
export function diff(branch: Branch, target: DiffTarget): Divergence[] {
  assertLive(branch);
  const branchDocs = branch.sandbox.snapshot().firestore;
  const targetDocs = snapshotOf(target).firestore;
  return diffDocSets(targetDocs, branchDocs);
}

/**
 * Promote a branch's mutations onto a target (live) sandbox.
 *
 * "Honest promote": it computes the doc-level delta between the branch's
 * BASE snapshot and its current state — i.e. exactly what the applied
 * events changed — and lands only those mutations on the target through
 * the admin plane:
 *   - docs added/changed on the branch → `admin.setDocument`
 *   - docs deleted on the branch       → `admin.deleteDocument`
 *   - docs the branch never touched    → left untouched on the target
 *
 * Admin-plane application fires the target's listeners (matching how
 * persistence restore lands docs), so live UI/handles see the promotion.
 *
 * The branch is marked discarded afterward — a promoted branch is spent.
 *
 * @param branch The experiment to land.
 * @param target The live sandbox to land it on.
 */
export function promote(branch: Branch, target: Sandbox): void {
  assertLive(branch);
  const baseDocs = branch.base.firestore;
  const finalDocs = branch.sandbox.snapshot().firestore;

  const paths = new Set([...Object.keys(baseDocs), ...Object.keys(finalDocs)]);
  for (const path of paths) {
    const before = baseDocs[path];
    const after = finalDocs[path];
    if (after === undefined) {
      // Branch deleted this doc relative to its base.
      target.admin.deleteDocument(path);
      continue;
    }
    if (before === undefined || !sandboxDocumentsEqual(before, after)) {
      // Branch added or changed this doc.
      target.admin.setDocument(path, after);
    }
    // else: unchanged on the branch — leave the target's copy alone.
  }

  branch.discarded = true;
  branch.sandbox.dispose();
}

/**
 * Discard a branch: drop its sandbox and mark it spent. The target is
 * never touched (nothing was promoted). Idempotent.
 */
export function discard(branch: Branch): void {
  if (branch.discarded) return;
  branch.discarded = true;
  branch.sandbox.dispose();
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function assertLive(branch: Branch): void {
  if (branch.discarded) {
    throw new Error('Branch has been discarded or promoted; create a new fork.');
  }
}

/** Resolve either a sandbox or a bare snapshot to a SandboxSnapshot. */
function snapshotOf(target: DiffTarget): SandboxSnapshot {
  if (isSandbox(target)) return target.snapshot();
  return target;
}

function isSandbox(target: DiffTarget): target is Sandbox {
  return typeof (target as Sandbox).snapshot === 'function';
}

/**
 * Doc-set structural diff. Mirrors the replay engine's doc-level + field-
 * level walk and reuses its `Divergence` result type. The replay engine's
 * own classifier is bound to captured write metadata (sentinels / auto-id
 * aliases) which a branch-vs-live comparison doesn't have, so this is the
 * "focused doc-level diff" the spec calls for when that machinery doesn't
 * fit: every leaf difference is `real-divergence`, and doc add/remove
 * surface as presence divergences (one side `undefined`).
 */
function diffDocSets(
  beforeDocs: Record<string, DocData>,
  afterDocs: Record<string, DocData>,
): Divergence[] {
  const out: Divergence[] = [];
  const allPaths = new Set([...Object.keys(beforeDocs), ...Object.keys(afterDocs)]);
  for (const path of allPaths) {
    const before = beforeDocs[path];
    const after = afterDocs[path];
    if (before === undefined && after !== undefined) {
      out.push({ kind: 'real-divergence', path, before: undefined, after });
      continue;
    }
    if (before !== undefined && after === undefined) {
      out.push({ kind: 'real-divergence', path, before, after: undefined });
      continue;
    }
    if (before === undefined || after === undefined) continue;
    walkDoc(path, before, after, out);
  }
  return out;
}

/**
 * Field-level walk producing dotted/bracket leaf paths — mirrors the
 * replay engine's `diffDoc` walk (same path syntax: `profile.lastSeen`,
 * `tags[0]`). Every leaf difference is `real-divergence`; there is no
 * captured sentinel metadata in a branch-vs-live diff to license drift.
 */
function walkDoc(path: string, before: unknown, after: unknown, out: Divergence[]): void {
  walk(before, after, '');

  function walk(a: unknown, b: unknown, fieldPath: string): void {
    if (a === b) return;

    const aIsObj = a !== null && typeof a === 'object' && !Array.isArray(a);
    const bIsObj = b !== null && typeof b === 'object' && !Array.isArray(b);
    if (aIsObj && bIsObj) {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
      for (const k of keys) {
        const next = fieldPath ? `${fieldPath}.${k}` : k;
        walk(ao[k], bo[k], next);
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        walk(a[i], b[i], `${fieldPath}[${i}]`);
      }
      return;
    }

    if (sandboxDocumentsEqual(a, b)) return;
    out.push({ kind: 'real-divergence', path, field: fieldPath || undefined, before: a, after: b });
  }
}

/** Structural equality on sandbox document snapshots. */
function sandboxDocumentsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sandboxDocumentsEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!sandboxDocumentsEqual(ao[k], bo[k])) return false;
  }
  return true;
}
