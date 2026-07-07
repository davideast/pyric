/**
 * Guarded GitHub branch push — feature branches only, no force, no tags.
 */
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

import { ensureRepo } from '~/lib/checkpoints/service';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

import {
  assertHeadNotBase,
  parseRepoFullName,
  validateFeatureBranch,
} from './branch-policy';
import { getRepoDetails } from './github-api';
import { getStoredPAT } from './github-auth';
import {
  ensureFeatureBranchSharesRemoteHistory,
  fetchWorkspaceRemoteDefaultBranch,
} from './workspace-github-remote';
import { normalizedAdapter } from './normalized-fs';

const DEFAULT_CORS_PROXY = 'https://cors.isomorphic-git.org';

export interface PushBranchResult {
  repo: string;
  branch: string;
  url: string;
}

export async function pushBranchToGitHub(opts: {
  repo: string;
  branch: string;
  dir?: string;
}): Promise<PushBranchResult> {
  const dir = opts.dir ?? WORKSPACE_ROOT;
  parseRepoFullName(opts.repo);
  validateFeatureBranch(opts.branch);

  const token = await getStoredPAT();
  if (!token) {
    throw new Error(
      'No GitHub personal access token configured. Add one in Settings → github.',
    );
  }

  const repoDetails = await getRepoDetails(opts.repo);
  if (!repoDetails.canPush) {
    throw new Error(`No push permission for ${opts.repo} — check your PAT scopes.`);
  }
  assertHeadNotBase(opts.branch, repoDetails.defaultBranch);

  if (dir === WORKSPACE_ROOT) {
    await ensureRepo();
    await fetchWorkspaceRemoteDefaultBranch(dir);
    await ensureFeatureBranchSharesRemoteHistory(
      opts.branch,
      repoDetails.defaultBranch,
      dir,
    );
  } else {
    const vfs = getVFS();
    try {
      await vfs.promises.stat(`${dir}/.git/HEAD`);
    } catch {
      throw new Error(`No git repository at ${dir} — clone a repo or use /workspace.`);
    }
  }

  const adapter = normalizedAdapter(getVFS());
  const fs = { promises: adapter.promises };

  try {
    await git.resolveRef({ fs, dir, ref: `refs/heads/${opts.branch}` });
  } catch {
    throw new Error(
      `Local branch "${opts.branch}" does not exist at ${dir} — create and commit on it first.`,
    );
  }

  const url = `https://github.com/${opts.repo}.git`;
  const result = await git.push({
    fs,
    http,
    dir,
    url,
    ref: opts.branch,
    remoteRef: opts.branch,
    force: false,
    onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
    corsProxy: DEFAULT_CORS_PROXY,
  });

  if (result.errors?.length) {
    throw new Error(result.errors.map(String).join('; '));
  }

  return {
    repo: opts.repo,
    branch: opts.branch,
    url: `https://github.com/${opts.repo}/tree/${encodeURIComponent(opts.branch)}`,
  };
}
