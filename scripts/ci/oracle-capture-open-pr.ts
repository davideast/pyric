/**
 * Pull request creation/update helper with PAT -> `github.token` fallback and
 * PAT `synchronize` re-push for `.github/workflows/oracle-capture.yml`.
 *
 * When a stored repository PAT has `contents: write` (pushing branches and
 * firing GitHub Actions events) but lacks `pull-requests: write`
 * (`Resource not accessible by personal access token (createPullRequest)`),
 * this helper falls back to `github.token` to create or edit the PR. Because
 * PRs newly created with `GITHUB_TOKEN` do not fire `pull_request: opened`
 * workflows, ONLY `fallbackRes.action === 'created'` is followed by an amended
 * commit timestamp (`+1s`, identical tree and message) force-pushed over the
 * PAT-authenticated `origin` remote to fire `pull_request: synchronize`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Gh } from './github-issues.ts';
import {
  assertValidObservationEnvelope,
  canonicalizeObservation,
  validateObservationRelativePath,
  type CollectedObservationChange,
} from './oracle-observation-diff.ts';

type PullRequestAuthMode =
  | 'pat'
  | 'github-token-with-pat-synchronize'
  | 'github-token-only';

export interface OpenPullRequestSummary {
  number: number;
  url: string;
  labels?: ReadonlyArray<{ name?: string | null }>;
  reviews?: readonly unknown[];
  reviewRequests?: readonly unknown[];
  reviewDecision?: string | null;
  comments?: readonly unknown[];
}

export interface OpenedPullRequestOutcome {
  rig: string;
  branch: string;
  action: 'created' | 'updated' | 'unchanged';
  prUrl: string;
  authMode?: PullRequestAuthMode;
}

interface PullRequestTarget {
  repository: string;
  rig: string;
  branch: string;
  title: string;
  bodyFile: string;
}

export interface PullRequestAuth {
  primaryGh: Gh;
  fallbackGh?: Gh;
  hasPatPushAuth: boolean;
}

export function hasCapturePullRequestActivity(pr: OpenPullRequestSummary): boolean {
  if (Array.isArray(pr.labels)) {
    for (const label of pr.labels) {
      if (
        typeof label?.name === 'string' &&
        label.name.trim().toLowerCase() === 'merge-queue'
      ) {
        return true;
      }
    }
  }
  if (Array.isArray(pr.reviews) && pr.reviews.length > 0) {
    return true;
  }
  if (Array.isArray(pr.reviewRequests) && pr.reviewRequests.length > 0) {
    return true;
  }
  if (typeof pr.reviewDecision === 'string' && pr.reviewDecision.trim() !== '') {
    return true;
  }
  if (Array.isArray(pr.comments) && pr.comments.length > 0) {
    return true;
  }
  return false;
}

export function formatShortCaptureSha(sourceSha: string): string {
  const trimmed = sourceSha.trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(trimmed)) {
    return trimmed.slice(0, 8);
  }
  const cleaned = trimmed.replace(/[^a-z0-9]+/g, '').slice(0, 8);
  if (cleaned === '') {
    return 'capture';
  }
  return cleaned;
}

function listOpenPullRequests(
  gh: Gh,
  repository: string,
  branch: string,
): OpenPullRequestSummary[] {
  return JSON.parse(
    gh([
      'pr',
      'list',
      '--repo',
      repository,
      '--head',
      branch,
      '--base',
      'main',
      '--state',
      'open',
      '--json',
      'number,url,labels,reviews,reviewRequests,reviewDecision,comments',
    ]),
  ) as OpenPullRequestSummary[];
}

function listOpenPullRequestsWithFallback(
  auth: PullRequestAuth,
  repository: string,
  branch: string,
): OpenPullRequestSummary[] {
  try {
    return listOpenPullRequests(auth.primaryGh, repository, branch);
  } catch (err) {
    if (!auth.fallbackGh) {
      throw err;
    }
    return listOpenPullRequests(auth.fallbackGh, repository, branch);
  }
}

export function resolveCaptureTargetBranch(options: {
  repository: string;
  rig: string;
  sourceSha: string;
  auth: PullRequestAuth;
}): { branch: string; divertedFromBranch: string | null } {
  const { repository, rig, sourceSha, auth } = options;
  const canonicalBranch = `chore/oracle-capture-${rig}`;
  const canonicalPrs = listOpenPullRequestsWithFallback(auth, repository, canonicalBranch);
  const existingCanonical = canonicalPrs[0];
  if (!existingCanonical || !hasCapturePullRequestActivity(existingCanonical)) {
    return { branch: canonicalBranch, divertedFromBranch: null };
  }

  const shortSha = formatShortCaptureSha(sourceSha);
  const baseFreshBranch = `chore/oracle-capture-${rig}-${shortSha}`;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    let candidate = baseFreshBranch;
    if (attempt > 1) {
      candidate = `${baseFreshBranch}-${attempt}`;
    }
    const candidatePrs = listOpenPullRequestsWithFallback(auth, repository, candidate);
    const existingCandidate = candidatePrs[0];
    if (!existingCandidate || !hasCapturePullRequestActivity(existingCandidate)) {
      return { branch: candidate, divertedFromBranch: canonicalBranch };
    }
  }
  throw new Error(`Unable to allocate an unreviewed capture branch for rig '${rig}'`);
}

export function preserveIdenticalProtectedObservations(
  cwd: string,
  protectedBranch: string,
  files: readonly CollectedObservationChange[],
): void {
  try {
    execFileSync('git', ['fetch', '--no-tags', 'origin', `refs/heads/${protectedBranch}`], {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    return;
  }
  for (const file of files) {
    let protectedText: string;
    try {
      protectedText = execFileSync('git', ['show', `FETCH_HEAD:${file.path}`], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    const currentPath = join(cwd, file.path);
    const nextText = readFileSync(currentPath, 'utf8');
    if (canonicalizeObservation(protectedText) === canonicalizeObservation(nextText)) {
      assertValidObservationEnvelope(file.path, protectedText);
      writeFileSync(currentPath, protectedText);
    }
  }
}

export function assertStagedPathsAreObservationsOnly(cwd: string): void {
  const stagedPaths = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (stagedPaths.length === 0) {
    throw new Error('Refusing empty staged diff for capture pull request');
  }
  for (const stagedPath of stagedPaths) {
    validateObservationRelativePath(stagedPath);
  }
}

export function spawnGhWithToken(cwd: string, token: string): Gh {
  return (args) => {
    const out = spawnSync('gh', args, {
      cwd,
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      encoding: 'utf8',
    });
    if (out.status !== 0) {
      throw new Error(`gh ${args[0]} ${args[1]} failed: ${out.stderr}`);
    }
    return out.stdout;
  };
}

function createOrEditPullRequest(
  gh: Gh,
  target: PullRequestTarget,
): { action: 'created' | 'updated'; prUrl: string } {
  const openPrs = listOpenPullRequests(gh, target.repository, target.branch);

  const existing = openPrs[0];
  if (existing) {
    gh([
      'pr', 'edit', String(existing.number), '--repo', target.repository,
      '--title', target.title, '--body-file', target.bodyFile,
    ]);
    return { action: 'updated', prUrl: existing.url };
  }

  const prUrl = gh([
    'pr', 'create', '--repo', target.repository, '--base', 'main',
    '--head', target.branch, '--title', target.title, '--body-file', target.bodyFile,
  ]).trim();
  return { action: 'created', prUrl };
}

function triggerPatSynchronizePush(cwd: string, branch: string): void {
  const currentCommitEpoch = Number(
    execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim(),
  );
  const minEpoch = Math.floor(Date.now() / 1000) + 1;
  let nextEpoch = minEpoch;
  if (Number.isFinite(currentCommitEpoch) && currentCommitEpoch + 1 > minEpoch) {
    nextEpoch = currentCommitEpoch + 1;
  }
  const nextDateIso = new Date(nextEpoch * 1000).toISOString();

  execFileSync('git', ['commit', '--amend', '--no-edit', '--no-gpg-sign'], {
    cwd,
    env: { ...process.env, GIT_COMMITTER_DATE: nextDateIso },
  });
  execFileSync('git', ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd });
}

export function createOrUpdatePullRequestWithFallback(options: {
  cwd: string;
  target: PullRequestTarget;
  auth: PullRequestAuth;
}): OpenedPullRequestOutcome {
  const { cwd, target, auth } = options;
  try {
    const res = createOrEditPullRequest(auth.primaryGh, target);
    let primaryMode: PullRequestAuthMode = 'github-token-only';
    if (auth.hasPatPushAuth) {
      primaryMode = 'pat';
    }
    return {
      rig: target.rig,
      branch: target.branch,
      action: res.action,
      prUrl: res.prUrl,
      authMode: primaryMode,
    };
  } catch (primaryErr) {
    if (!auth.fallbackGh) {
      throw primaryErr;
    }
    let reason = String(primaryErr);
    if (primaryErr instanceof Error) {
      reason = primaryErr.message;
    }
    console.warn(
      `[oracle-capture] primary token PR operation failed (${reason}); falling back to github.token`,
    );
    const fallbackRes = createOrEditPullRequest(auth.fallbackGh, target);
    let authMode: PullRequestAuthMode = 'github-token-only';
    if (auth.hasPatPushAuth) {
      if (fallbackRes.action === 'created') {
        triggerPatSynchronizePush(cwd, target.branch);
        authMode = 'github-token-with-pat-synchronize';
      } else {
        authMode = 'pat';
      }
    }
    return {
      rig: target.rig,
      branch: target.branch,
      action: fallbackRes.action,
      prUrl: fallbackRes.prUrl,
      authMode,
    };
  }
}

export function formatPullRequestOutcomesSummary(
  outcomes: readonly OpenedPullRequestOutcome[],
): string {
  const bullets = outcomes.map((item) => {
    let urlPart = '';
    if (item.prUrl) {
      urlPart = ` - ${item.prUrl}`;
    }
    let authNote = '';
    if (item.authMode === 'pat') {
      authNote = ' (via PAT)';
    } else if (item.authMode === 'github-token-with-pat-synchronize') {
      authNote = ' (via github.token fallback + PAT synchronize push)';
    } else if (item.authMode === 'github-token-only') {
      authNote = ' (via github.token only; no PAT configured for CI trigger)';
    }
    return `- **${item.rig}** (\`${item.branch}\`): ${item.action}${authNote}${urlPart}`;
  });
  return ['## Oracle capture pull requests', '', ...bullets].join('\n');
}
