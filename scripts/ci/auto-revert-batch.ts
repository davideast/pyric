// Finds the one pull request to revert when the commit that turned main red
// is a merge queue batch. `auto-revert-github.ts` calls it in place of
// reverting the whole commit.
//
// A batch commit has the previous main as its first parent and, as its
// second, a chain of merge commits, one per pull request
// (`merge-queue-github.ts`). The batch failed and the commit before it
// passed, so the culprit is the first pull request whose prefix of the chain
// fails. Each prefix is tried as a probe: a commit of the prefix's tree on
// top of the previous main, pushed to its own `merge-queue/bisect/` branch,
// with the failed workflow dispatched on it. A probe that fails is rerun
// once before it counts. `auto-revert.yml` runs this again when a probe
// finishes, until `decideBatch` names the culprit.

import { parseStagedPulls, parseStagingCommit } from './merge-queue.ts';
import { decideBatch, type BatchVerdict, type FailedRun, type ProbeResult } from './auto-revert.ts';

/** Probe branches: `<prefix><batch commit>/<workflow id>/<member index>`. The
 *  `merge-queue/` prefix gives a dispatched Build & Test its full check set. */
export const BISECT_PREFIX = 'merge-queue/bisect/';
const BISECT_BRANCH = /^merge-queue\/bisect\/([0-9a-f]{40})\/(\d+)\/(\d+)$/;
const FAILED = new Set(['failure', 'timed_out']);

export interface BatchIo {
  gh: (args: string[]) => string;
  git: (args: string[]) => string;
  log: (text: string) => void;
  repo: string;
}

export interface BatchCommit {
  sha: string;
  parents: string[];
  message: string;
}

/** One pull request's merge commit in the chain. */
export interface BatchMember extends BatchCommit {
  pull?: NonNullable<FailedRun['pull']>;
}

export interface BisectTarget {
  /** The batch commit on main whose run failed. */
  commit: string;
  workflowId: number;
  index: number;
}

interface CommitJson {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string };
}

interface ProbeRun {
  run_attempt: number;
  status: string;
  conclusion: string | null;
}

function api<T>(io: BatchIo, path: string): T {
  return JSON.parse(io.gh(['api', `repos/${io.repo}/${path}`])) as T;
}

export function bisectBranch(target: BisectTarget): string {
  return `${BISECT_PREFIX}${target.commit}/${target.workflowId}/${target.index}`;
}

export function parseBisectBranch(branch: string): BisectTarget | undefined {
  const match = BISECT_BRANCH.exec(branch);
  if (!match) return undefined;
  return { commit: match[1]!, workflowId: Number(match[2]), index: Number(match[3]) };
}

/** The pull request a queue commit merged, when its trailer names exactly one. */
export function queuedPull(io: BatchIo, message: string): FailedRun['pull'] {
  const staged = parseStagedPulls(message);
  const only = staged[0];
  if (staged.length !== 1 || only === undefined) return undefined;
  const pull = api<{ number: number; title: string; head: { ref: string } }>(io, `pulls/${only.number}`);
  return { number: pull.number, title: pull.title, headRef: pull.head.ref };
}

/** The chain of a batch commit, first landed first, or undefined when the
 *  commit is not a batch of two or more that the merge queue wrote. */
export function batchMembers(io: BatchIo, commit: BatchCommit): BatchMember[] | undefined {
  const size = parseStagingCommit(commit.message)?.pulls.length ?? 0;
  const [base, chain] = commit.parents;
  if (size < 2 || commit.parents.length !== 2 || base === undefined || chain === undefined) return undefined;
  const members: BatchMember[] = [];
  let sha = chain;
  for (let step = 0; step < size; step++) {
    const json = api<CommitJson>(io, `commits/${sha}`);
    const parents = json.parents.map((parent) => parent.sha);
    const first = parents[0];
    if (parents.length !== 2 || first === undefined) return undefined;
    members.unshift({ sha: json.sha, parents, message: json.commit.message, pull: queuedPull(io, json.commit.message) });
    sha = first;
  }
  if (sha !== base) return undefined;
  return members;
}

function probeResult(run: ProbeRun | undefined): ProbeResult {
  // A branch with no run yet was pushed and is about to be dispatched.
  if (run === undefined || run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success') return 'passed';
  // A failed first attempt is rerun before it counts; a cancelled probe never
  // settles, so the bisect stops there and a person takes over.
  if (FAILED.has(run.conclusion ?? '') && run.run_attempt >= 2) return 'failed';
  return 'pending';
}

/** What the probes of this batch and workflow have shown so far, by member index. */
function probeResults(io: BatchIo, commit: string, workflowId: number): Map<number, ProbeResult> {
  const results = new Map<number, ProbeResult>();
  const listing = io.git(['ls-remote', 'origin', `refs/heads/${BISECT_PREFIX}${commit}/${workflowId}/*`]);
  for (const line of listing.split('\n')) {
    const branch = (line.trim().split(/\s+/)[1] ?? '').replace('refs/heads/', '');
    const target = parseBisectBranch(branch);
    if (target === undefined) continue;
    const runs = api<{ workflow_runs: ProbeRun[] }>(io, `actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&per_page=5`);
    results.set(target.index, probeResult(runs.workflow_runs[0]));
  }
  return results;
}

/** Pushes the probe for the batch cut off after `index` and starts the
 *  workflow on it. Its first parent is the commit before the batch, so the
 *  run compares with the same base the batch's own run did. */
function startProbe(io: BatchIo, target: BisectTarget, base: string, members: readonly BatchMember[], workflowFile: string): void {
  const member = members[target.index];
  if (member === undefined) throw new Error(`batch ${target.commit} has no member ${target.index}`);
  const branch = bisectBranch(target);
  io.git(['config', 'user.name', 'github-actions[bot]']);
  io.git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const tree = io.git(['rev-parse', `${member.sha}^{tree}`]).trim();
  const message = `auto-revert bisect: ${target.commit} through pull request ${target.index + 1} of ${members.length}`;
  const probe = io.git(['commit-tree', tree, '-p', base, '-m', message]).trim();
  io.git(['push', 'origin', `${probe}:refs/heads/${branch}`]);
  io.gh(['workflow', 'run', workflowFile, '--repo', io.repo, '--ref', branch]);
  io.log(`Bisecting batch ${target.commit}: started ${workflowFile} on ${branch} for the first ${target.index + 1} of ${members.length} pull requests.`);
}

export interface BatchRun {
  commit: BatchCommit;
  workflowId: number;
  /** The failed workflow's file name, such as `build.yml`. */
  workflowFile: string;
}

/** Takes the next bisect step for a failed batch: names the culprit, starts
 *  the next probe, or waits for the probe in flight. */
export function bisectBatch(io: BatchIo, run: BatchRun, members: readonly BatchMember[], dryRun: boolean): BatchVerdict {
  const base = run.commit.parents[0] ?? '';
  const verdict = decideBatch(members.length, probeResults(io, run.commit.sha, run.workflowId));
  const target: BisectTarget = { commit: run.commit.sha, workflowId: run.workflowId, index: verdict.index };
  if (verdict.kind === 'wait') io.log(`Bisecting batch ${run.commit.sha}: waiting for the run on ${bisectBranch(target)}.`);
  if (verdict.kind === 'probe' && dryRun) io.log(`Dry run, would bisect batch ${run.commit.sha} with a run on ${bisectBranch(target)}.`);
  if (verdict.kind === 'probe' && !dryRun) startProbe(io, target, base, members, run.workflowFile);
  return verdict;
}

/** Deletes this workflow's probe branches of a batch once its culprit is known. */
export function deleteProbes(io: BatchIo, commit: string, workflowId: number): void {
  const listing = io.git(['ls-remote', 'origin', `refs/heads/${BISECT_PREFIX}${commit}/${workflowId}/*`]);
  for (const line of listing.split('\n')) {
    const ref = line.trim().split(/\s+/)[1];
    if (ref === undefined || ref === '') continue;
    try {
      io.git(['push', 'origin', '--delete', ref]);
    } catch {
      // Another job deleted it first.
    }
  }
}
