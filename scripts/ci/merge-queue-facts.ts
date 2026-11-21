// Read-only GitHub and git fact gathering for the Actions merge queue.
// `merge-queue-github.ts` passes the gathered `QueueFacts` to `decideQueueStep`.

import { FAILED_CONCLUSIONS, isWatchedMainRun } from './auto-revert.ts';
import { BISECT_PREFIX, parseBisectBranch } from './auto-revert-batch.ts';
import {
  QUEUE_LABEL,
  REFUSED_BRANCH,
  STAGING_BRANCH,
  parseStagingCommit,
  type ActiveStaging,
  type CheckState,
  type LandAction,
  type QueueFacts,
  type QueuedPull,
  type StagingRun,
} from './merge-queue.ts';

export const BUILD_WORKFLOW = 'build.yml';
export const SLOW_WORKFLOW = 'slow-scenarios.yml';
const REQUIRED_CHECK = 'CI / required';
/** The workflows whose trunk failure on `main` holds normal pull requests:
 *  the ones the auto-revert lane watches. */
const WATCHED_ON_MAIN: ReadonlyArray<{ file: string; name: string }> = [
  { file: BUILD_WORKFLOW, name: 'Build & Test' },
  { file: SLOW_WORKFLOW, name: 'Slow app scenarios' },
];

export interface QueueIo {
  repo: string;
  gh: (args: string[]) => string;
  /** Optional `gh` runner backed by the workflow's `github.token` (`checks: read`,
   *  `issues: write`, and its own repo-scoped rate limit) for read-only GitHub
   *  API queries, issue comments, and queue label removals. Defaults to `gh`
   *  when omitted. */
  ghWorkflow?: (args: string[]) => string;
  /** Legacy checks-only fallback for `commits/<sha>/check-runs` when
   *  `ghWorkflow` is omitted. Defaults to `gh` when both are omitted. */
  ghChecks?: (args: string[]) => string;
  git: (args: string[]) => string;
  log: (text: string) => void;
  writeFile: (name: string, text: string) => string;
  now: () => number;
}

interface PullApiItem {
  number: number;
  title: string;
  state?: string;
  draft: boolean;
  created_at: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
}

interface IssueEventItem {
  event: string;
  created_at: string;
  label?: { name?: string } | null;
}

interface CheckRunItem {
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string } | null;
}

interface WorkflowRunItem {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  event?: string;
  head_branch?: string;
  actor?: { login?: string } | null;
}

export function resolveWorkflowToken(env: Record<string, string | undefined>): string | undefined {
  const workflowToken = env.GH_WORKFLOW_TOKEN;
  if (workflowToken) return workflowToken;
  const legacyChecksToken = env.GH_CHECKS_TOKEN;
  if (legacyChecksToken) return legacyChecksToken;
  return undefined;
}

export function workflowGh(io: QueueIo): (args: string[]) => string {
  if (io.ghWorkflow !== undefined) return io.ghWorkflow;
  return io.gh;
}

function checksGh(io: QueueIo): (args: string[]) => string {
  if (io.ghWorkflow !== undefined) return io.ghWorkflow;
  if (io.ghChecks !== undefined) return io.ghChecks;
  return io.gh;
}

function apiGetWith<T>(run: (args: string[]) => string, repo: string, path: string): T {
  return JSON.parse(run(['api', `repos/${repo}/${path}`])) as T;
}

function apiGet<T>(io: QueueIo, path: string): T {
  return apiGetWith<T>(workflowGh(io), io.repo, path);
}

export function mainHeadSha(io: QueueIo): string {
  return apiGet<{ commit: { sha: string } }>(io, 'branches/main').commit.sha;
}

export function isAncestor(io: QueueIo, candidate: string, descendant: string): boolean {
  try {
    io.git(['merge-base', '--is-ancestor', candidate, descendant]);
    return true;
  } catch {
    return false;
  }
}

interface LivePullHead {
  sha: string;
  repo?: { full_name?: string } | null;
}

function isSameLiveRepo(head: LivePullHead, repo: string): boolean {
  if (head.repo === null) return false;
  if (head.repo?.full_name === undefined) return true;
  return head.repo.full_name === repo;
}

/** Whether `main` is still the batch's base and every pull request in it is
 *  still open on the same repository at the staged head. */
export function landingStillStands(io: QueueIo, action: LandAction): boolean {
  try {
    if (mainHeadSha(io) !== action.baseSha) return false;
    return action.pulls.every((pull) => {
      const current = apiGet<{ state: string; head: LivePullHead }>(io, `pulls/${pull.number}`);
      return current.state === 'open' && current.head.sha === pull.headSha && isSameLiveRepo(current.head, io.repo);
    });
  } catch {
    return false;
  }
}

/** Throws unless the tree on `main` is the tree the staging run proved, and
 *  returns the verified commit SHA on `main`. */
export function verifyLanded(io: QueueIo, action: LandAction, numbersLabel: string): string {
  const remoteLine = io.git(['ls-remote', 'origin', 'refs/heads/main']).trim();
  const firstToken = remoteLine.split(/\s+/)[0];
  let mainSha = '';
  if (firstToken !== undefined) mainSha = firstToken;
  io.git(['fetch', '--no-tags', 'origin', mainSha]);
  const mainTree = io.git(['rev-parse', `${mainSha}^{tree}`]).trim();
  const provenTree = io.git(['rev-parse', `${action.stagingSha}^{tree}`]).trim();
  if (mainTree === '' || mainTree !== provenTree) {
    throw new Error(`After landing ${numbersLabel}, main is ${mainSha} with tree ${mainTree}, but the staging run (${action.runUrl}) proved ${action.stagingSha} with tree ${provenTree}.`);
  }
  return mainSha;
}

export function pullAlreadyLanded(io: QueueIo, pull: QueuedPull, currentMainSha: string): boolean {
  try {
    const current = apiGet<{ state: string; merged?: boolean; head?: { sha?: string } }>(io, `pulls/${pull.number}`);
    if (current.merged === true) return true;
    const liveSha = current.head?.sha;
    if (liveSha !== undefined && liveSha !== '' && liveSha !== pull.headSha) return false;
    io.git(['fetch', '--no-tags', 'origin', currentMainSha, pull.headSha]);
    return isAncestor(io, pull.headSha, currentMainSha);
  } catch {
    return false;
  }
}

function pageQuery(page: number): string {
  if (page === 1) return 'per_page=100';
  return `per_page=100&page=${page}`;
}

/** Paths touched by a pull request, including prior paths of renamed files. */
export function pullChangedPaths(io: QueueIo, prNumber: number): string[] {
  const filenames: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = apiGet<Array<{ filename: string; previous_filename?: string }>>(io, `pulls/${prNumber}/files?${pageQuery(page)}`);
    for (const item of batch) {
      filenames.push(item.filename);
      if (item.previous_filename !== undefined && item.previous_filename !== '') {
        filenames.push(item.previous_filename);
      }
    }
    if (batch.length < 100) break;
  }
  return filenames;
}

function latestRequiredCheck(io: QueueIo, sha: string): { state: CheckState; conclusion: string | null } {
  const encoded = encodeURIComponent(REQUIRED_CHECK);
  const response = apiGetWith<{ check_runs: CheckRunItem[] }>(
    checksGh(io),
    io.repo,
    `commits/${sha}/check-runs?check_name=${encoded}&filter=latest`,
  );
  const run = response.check_runs.find((item) => item.app?.slug === 'github-actions') ?? response.check_runs[0];
  if (run === undefined || run.status !== 'completed') return { state: 'pending', conclusion: null };
  if (run.conclusion === 'success') return { state: 'success', conclusion: 'success' };
  return { state: 'failure', conclusion: run.conclusion };
}

function latestLabeledTime(io: QueueIo, prNumber: number, fallbackCreatedAt: string): string {
  let labeledAt = fallbackCreatedAt;
  for (let page = 1; page <= 10; page++) {
    const events = apiGet<IssueEventItem[]>(io, `issues/${prNumber}/events?${pageQuery(page)}`);
    for (const item of events) {
      if (item.event === 'labeled' && item.label?.name === QUEUE_LABEL) {
        labeledAt = item.created_at;
      }
    }
    if (events.length < 100) break;
  }
  return labeledAt;
}

function gatherQueuedPulls(io: QueueIo): QueuedPull[] {
  const pulls = apiGet<PullApiItem[]>(io, 'pulls?state=open&base=main&per_page=100');
  const queued = pulls.filter((item) => item.labels.some((label) => label.name === QUEUE_LABEL));
  return queued.map((item) => {
    const labelNames = item.labels.map((label) => label.name);
    const headRepoFullName = item.head.repo?.full_name ?? '';
    const labeledAt = latestLabeledTime(io, item.number, item.created_at);
    const requiredCheck = latestRequiredCheck(io, item.head.sha);
    return {
      number: item.number,
      title: item.title,
      isDraft: item.draft,
      headRef: item.head.ref,
      headSha: item.head.sha,
      headRepoFullName,
      labels: labelNames,
      labeledAt,
      prRequiredState: requiredCheck.state,
    };
  });
}

function failedJobNames(io: QueueIo, runId: number, attempt: number): string[] {
  const response = apiGet<{ jobs: Array<{ name: string; conclusion: string | null }> }>(
    io,
    `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
  );
  return response.jobs
    .filter((job) => FAILED_CONCLUSIONS.has(job.conclusion ?? ''))
    .map((job) => job.name);
}

/** The commits the queue's own branches (staging, refusal marker, and active
 *  auto-revert bisect probes) point at, keyed by branch name. */
function queueBranches(io: QueueIo): Map<string, string> {
  const listing = io.git([
    'ls-remote',
    'origin',
    `refs/heads/${STAGING_BRANCH}`,
    `refs/heads/${REFUSED_BRANCH}`,
    `refs/heads/${BISECT_PREFIX}*`,
  ]);
  const branches = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) branches.set(ref.replace('refs/heads/', ''), sha);
  }
  return branches;
}

function stagingBuildRun(io: QueueIo, stagingSha: string): StagingRun | undefined {
  const encodedBranch = encodeURIComponent(STAGING_BRANCH);
  const runs = apiGet<{ workflow_runs: WorkflowRunItem[] }>(
    io,
    `actions/workflows/${BUILD_WORKFLOW}/runs?branch=${encodedBranch}&head_sha=${stagingSha}&per_page=10`,
  );
  const latestRun = runs.workflow_runs[0];
  if (latestRun === undefined) return undefined;
  let requiredCheckState: CheckState = 'pending';
  let requiredCheckConclusion: string | null = null;
  let failedJobs: string[] = [];
  if (latestRun.status === 'completed') {
    const check = latestRequiredCheck(io, stagingSha);
    requiredCheckState = check.state;
    requiredCheckConclusion = check.conclusion;
    if (latestRun.conclusion !== 'success') {
      failedJobs = failedJobNames(io, latestRun.id, latestRun.run_attempt);
    }
  }
  return {
    id: latestRun.id,
    attempt: latestRun.run_attempt,
    totalRunsForCommit: runs.workflow_runs.length,
    status: latestRun.status,
    conclusion: latestRun.conclusion,
    requiredCheckState,
    requiredCheckConclusion,
    url: latestRun.html_url,
    failedJobs,
  };
}

function gatherActiveStaging(io: QueueIo, stagingSha: string | undefined): ActiveStaging | undefined {
  if (stagingSha === undefined) return undefined;
  const commit = apiGet<{ commit: { message: string; committer: { date: string } } }>(io, `commits/${stagingSha}`);
  const meta = parseStagingCommit(commit.commit.message);
  const staging: ActiveStaging = { stagingSha, committedAtMs: Date.parse(commit.commit.committer.date) };
  if (meta !== undefined) staging.meta = meta;
  const buildRun = stagingBuildRun(io, stagingSha);
  if (buildRun !== undefined) staging.buildRun = buildRun;
  return staging;
}

/** A watched workflow whose latest trunk run (`push` or bot dispatch) on the
 *  head of `main` failed or is being rerun, or an active auto-revert bisect
 *  whose target has not yet been superseded by a green `main`. Nightly
 *  `schedule` runs and manual human dispatches are ignored. */
function gatherMainRed(io: QueueIo, mainSha: string, branches: ReadonlyMap<string, string>): QueueFacts['mainRed'] {
  let allWatchedGreen = true;
  for (const watched of WATCHED_ON_MAIN) {
    const runs = apiGet<{ workflow_runs: WorkflowRunItem[] }>(
      io,
      `actions/workflows/${watched.file}/runs?branch=main&head_sha=${mainSha}&per_page=100`,
    );
    const latest = runs.workflow_runs.find(isWatchedMainRun);
    if (latest === undefined) {
      allWatchedGreen = false;
      continue;
    }
    const conclusion = latest.conclusion ?? '';
    const failed = latest.status === 'completed' && FAILED_CONCLUSIONS.has(conclusion);
    const rerunning = latest.status !== 'completed' && latest.run_attempt > 1;
    if (failed || rerunning) return { workflow: watched.name, runUrl: latest.html_url };
    if (latest.status !== 'completed' || conclusion !== 'success') allWatchedGreen = false;
  }
  for (const branch of branches.keys()) {
    const target = parseBisectBranch(branch);
    if (target === undefined) continue;
    if (target.commit === mainSha || !allWatchedGreen) {
      return {
        workflow: `batch ${target.commit.slice(0, 9)} (bisect in progress)`,
        runUrl: `https://github.com/${io.repo}/commit/${target.commit}`,
      };
    }
  }
  return undefined;
}

export function gatherFacts(io: QueueIo): QueueFacts {
  const mainSha = mainHeadSha(io);
  const candidates = gatherQueuedPulls(io);
  const branches = queueBranches(io);
  const activeStaging = gatherActiveStaging(io, branches.get(STAGING_BRANCH));
  const mainRed = gatherMainRed(io, mainSha, branches);
  const refusedStagingSha = branches.get(REFUSED_BRANCH);
  const facts: QueueFacts = { repo: io.repo, mainSha, candidates, nowMs: io.now() };
  if (activeStaging !== undefined) facts.activeStaging = activeStaging;
  if (mainRed !== undefined) facts.mainRed = mainRed;
  if (refusedStagingSha !== undefined) facts.refusedStagingSha = refusedStagingSha;
  return facts;
}
