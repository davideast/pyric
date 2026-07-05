/**
 * Staged changes: the client-side proposal registry (AI-as-flow, thin slice).
 *
 * A staged change is "an open branch + an id" (see
 * the design rationale). A producer (the command-spine
 * prompt, a manual "stage this", or later the agent) calls {@link stage}: the
 * live snapshot is forked, the change's writes run on the COPY (admin handle,
 * rules bypassed: staging never touches live, so it is always safe), and the
 * result is held as an OPEN proposal. The Session surface lists open proposals;
 * the Review surface shows `diff(branch, live-now)`; Apply replays the staged
 * docs onto live (the gated step), Discard drops the copy.
 *
 * SCOPE (thin slice): this registry lives in the browser and applies through the
 * Studio data bridge (`useStudioSnapshot` + `useStudioSeed`), so it works in both
 * the served demo and standalone with no worker-protocol plumbing. The spec's
 * worker-host registry (cross-client + persistence) is the follow-up. Apply
 * covers writes; deletes route through the worker-host `promote()` later.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  fork,
  diff,
  discard,
  type Branch,
  type Divergence,
  type SandboxSnapshot,
} from 'pyric/sandbox';
import { getAdminFirestore, type Firestore } from 'pyric/firestore';
import {
  useStudioSnapshot,
  useStudioSeed,
  useStudioSeedAuth,
  type SeedOp,
  type AuthCreateOp,
} from '../../shell/studio-data.js';

/** Who staged the change (provenance, per the spec's `EventActor`). */
export type ProposalActor = 'you' | 'studio' | `agent:${string}`;

export interface Proposal {
  id: string;
  title: string;
  actor: ProposalActor;
  createdAt: number;
  status: 'open' | 'applied' | 'discarded';
  /** The staged copy (a fork) holding the change's writes. */
  branch: Branch;
  /** The snapshot the change was staged against (drift baseline). */
  base: SandboxSnapshot;
  /** Auth users the change staged on the branch. Captured explicitly because
   *  `diff()` is Firestore-only; replayed onto live as admin on apply. */
  authOps: AuthCreateOp[];
}

/** What a producer's `plan` may return: the non-Firestore ops it staged that the
 *  branch diff cannot see (currently auth-user creates). */
export interface StagePlanResult {
  authOps?: readonly AuthCreateOp[];
}

export interface StageInput {
  title: string;
  actor: ProposalActor;
  /** Runs the change's writes against the forked copy. Receives the base
   *  snapshot (to enumerate what to touch) and the branch itself, so a producer
   *  can reach non-Firestore services on the fork - e.g. `getAuth(branch.sandbox)`
   *  to stage auth users in isolation from live. Returns any non-Firestore ops
   *  (auth users) so they can be replayed on apply. */
  plan: (
    db: Firestore,
    base: SandboxSnapshot,
    branch: Branch,
  ) => Promise<StagePlanResult | void> | StagePlanResult | void;
}

export type ApplyResult =
  | { status: 'applied'; written: number; created: number; errors: string[] }
  | { status: 'conflict'; conflicts: string[] };

// ── Module store (the client-side registry) ─────────────────────────────────
const registry = new Map<string, Proposal>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getVersion(): number {
  return version;
}

// The proposal the Review surface is focused on (set when you click "Review" on
// a session action item). Cross-surface, like the data nav's selected denial.
let focusedId: string | null = null;
export function focusProposal(id: string | null): void {
  focusedId = id;
  emit();
}
export function useFocusedProposalId(): string | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return focusedId;
}

// Governance mode: whether a staged change is GATED by review before it lands.
//   'review' (default, safe) - stage on a copy, apply only after you review.
//   'direct'                 - apply immediately, no review step.
// Persisted so the choice survives a reload. Producers (the stage trigger, and
// later the prompt/agent) read this to decide whether to auto-apply.
export type GovernanceMode = 'review' | 'direct';
const GOVERNANCE_KEY = 'pyric.studio.governance';
function readGovernance(): GovernanceMode {
  if (typeof localStorage === 'undefined') return 'review';
  try {
    return localStorage.getItem(GOVERNANCE_KEY) === 'direct' ? 'direct' : 'review';
  } catch {
    return 'review';
  }
}
let governanceMode: GovernanceMode = readGovernance();
export function setGovernanceMode(mode: GovernanceMode): void {
  governanceMode = mode;
  try {
    localStorage.setItem(GOVERNANCE_KEY, mode);
  } catch {
    /* private mode / disabled storage: non-fatal */
  }
  emit();
}
export function useGovernanceMode(): {
  mode: GovernanceMode;
  setMode: (mode: GovernanceMode) => void;
} {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return { mode: governanceMode, setMode: setGovernanceMode };
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p_${version}_${Math.floor(Math.random() * 1e9)}`;
}

/** Stable JSON identity for drift comparison of a single doc. */
function sameDoc(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The doc path a divergence touches. Only `real-divergence` carries one (and
 *  that's all a branch-vs-snapshot diff produces); other variants are
 *  replay-only metadata drift, skipped here. */
function divergencePath(d: Divergence): string | null {
  return 'path' in d ? (d as { path: string }).path : null;
}

// ── Operations (the hook injects the snapshot getter + the apply primitive) ──

async function stageProposal(
  getSnapshot: () => Promise<SandboxSnapshot | null>,
  input: StageInput,
): Promise<Proposal> {
  const base = await getSnapshot();
  if (!base) throw new Error('No sandbox to stage a change against.');
  const branch = fork(base, '');
  let planResult: StagePlanResult | void;
  try {
    planResult = await input.plan(getAdminFirestore(branch.sandbox), base, branch);
  } catch (e) {
    // The producer (agent) failed: drop the copy and surface the error rather
    // than registering an empty proposal.
    discard(branch);
    throw e;
  }
  const proposal: Proposal = {
    id: makeId(),
    title: input.title,
    actor: input.actor,
    createdAt: Date.now(),
    status: 'open',
    branch,
    base,
    authOps: [...(planResult?.authOps ?? [])],
  };
  registry.set(proposal.id, proposal);
  emit();
  return proposal;
}

/** The Review diff: branch vs live-now, so it never lies about the current
 *  effect of applying (falls back to the base if live is gone). */
async function freshDiffOf(
  getSnapshot: () => Promise<SandboxSnapshot | null>,
  id: string,
): Promise<Divergence[]> {
  const p = registry.get(id);
  if (!p) return [];
  const live = await getSnapshot();
  return diff(p.branch, live ?? p.base);
}

async function applyProposal(
  getSnapshot: () => Promise<SandboxSnapshot | null>,
  applySeed: (ops: readonly SeedOp[]) => Promise<{ written: number; errors: string[] }>,
  applySeedAuth: (ops: readonly AuthCreateOp[]) => Promise<{ created: number; errors: string[] }>,
  id: string,
  opts?: { force?: boolean },
): Promise<ApplyResult> {
  const p = registry.get(id);
  if (!p || p.status !== 'open') throw new Error('No open proposal to apply.');
  const live = await getSnapshot();
  if (!live) throw new Error('No live sandbox to apply onto.');

  const staged = diff(p.branch, p.base); // the docs the change produced
  const touched = [
    ...new Set(staged.map(divergencePath).filter((path): path is string => path !== null)),
  ];

  // Surface-conflicts: a touched doc that live changed since we staged is drift.
  // (Firestore-only; auth conflicts have no pre-flight check and surface as
  // per-op errors below, e.g. `auth/uid-already-exists`.)
  const conflicts = touched.filter(
    (path) => !sameDoc(p.base.firestore[path], live.firestore[path]),
  );
  if (conflicts.length > 0 && !opts?.force) {
    return { status: 'conflict', conflicts };
  }

  // Apply auth users first (so Firestore docs referencing their uids are
  // consistent), then the touched docs - both as admin.
  const authRes = p.authOps.length
    ? await applySeedAuth(p.authOps)
    : { created: 0, errors: [] };
  const branchDocs = p.branch.sandbox.snapshot().firestore;
  const ops: SeedOp[] = touched
    .filter((path) => branchDocs[path] !== undefined)
    .map((path) => ({ path, data: branchDocs[path] }));
  const res = await applySeed(ops);

  p.status = 'applied';
  discard(p.branch);
  emit();
  return {
    status: 'applied',
    written: res.written,
    created: authRes.created,
    errors: [...authRes.errors, ...res.errors],
  };
}

function discardProposal(id: string): void {
  const p = registry.get(id);
  if (!p) return;
  if (p.status === 'open') discard(p.branch);
  p.status = 'discarded';
  emit();
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseProposalsResult {
  /** Open proposals, newest first. */
  open: Proposal[];
  get(id: string): Proposal | undefined;
  stage(input: StageInput): Promise<Proposal>;
  freshDiff(id: string): Promise<Divergence[]>;
  apply(id: string, opts?: { force?: boolean }): Promise<ApplyResult>;
  discard(id: string): void;
}

export function useProposals(): UseProposalsResult {
  const getSnapshot = useStudioSnapshot();
  const applySeed = useStudioSeed();
  const applySeedAuth = useStudioSeedAuth();
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);

  const open = useMemo<Proposal[]>(
    () =>
      [...registry.values()]
        .filter((p) => p.status === 'open')
        .sort((a, b) => b.createdAt - a.createdAt),
    [v],
  );

  const stage = useCallback((input: StageInput) => stageProposal(getSnapshot, input), [getSnapshot]);
  const freshDiff = useCallback((id: string) => freshDiffOf(getSnapshot, id), [getSnapshot]);
  const apply = useCallback(
    (id: string, opts?: { force?: boolean }) =>
      applyProposal(getSnapshot, applySeed, applySeedAuth, id, opts),
    [getSnapshot, applySeed, applySeedAuth],
  );
  const discardCb = useCallback((id: string) => discardProposal(id), []);

  return { open, get: (id) => registry.get(id), stage, freshDiff, apply, discard: discardCb };
}
