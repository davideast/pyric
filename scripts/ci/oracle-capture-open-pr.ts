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
import type { Gh } from './github-issues.ts';

type PullRequestAuthMode =
  | 'pat'
  | 'github-token-with-pat-synchronize'
  | 'github-token-only';

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

interface PullRequestAuth {
  primaryGh: Gh;
  fallbackGh?: Gh;
  hasPatPushAuth: boolean;
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
  const openPrs = JSON.parse(
    gh([
      'pr', 'list', '--repo', target.repository, '--head', target.branch,
      '--base', 'main', '--state', 'open', '--json', 'number,url',
    ]),
  ) as Array<{ number: number; url: string }>;

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
