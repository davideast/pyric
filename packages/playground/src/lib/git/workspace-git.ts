/**
 * Agent-facing local git operations on /workspace (isomorphic-git).
 * Bash has no `git` binary — use `workspace_git` instead.
 */
import { resyncWorkspaceMirror } from '~/lib/files/bootstrap';
import * as git from 'isomorphic-git';

import { ensureRepo } from '~/lib/checkpoints/service';
import { resolveGitCommitAuthor } from '~/lib/git/git-author';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

import { validateFeatureBranch } from './branch-policy';
import { ensureBufferPolyfill } from './buffer-polyfill';
import { fetchWorkspaceRemoteDefaultBranch, resolveWorkspaceRemoteLink } from './workspace-github-remote';
import { normalizedAdapter } from './normalized-fs';
import { GitService } from './git-service';

const DIR = WORKSPACE_ROOT;

function services(): { svc: GitService; fs: { promises: ReturnType<typeof getVFS>['promises'] } } {
  ensureBufferPolyfill();
  const adapter = normalizedAdapter(getVFS());
  return { svc: new GitService(adapter), fs: { promises: adapter.promises } };
}

export interface WorkspaceGitStatus {
  branch: string;
  dirtyFiles: number;
  headSha: string | null;
}

export async function getWorkspaceGitStatus(): Promise<WorkspaceGitStatus> {
  await ensureRepo();
  const { fs, svc } = services();
  let branch = 'main';
  try {
    branch = await git.currentBranch({ fs, dir: DIR });
  } catch {
    // unborn HEAD — stay on default label
  }
  const rows = await svc.status(DIR);
  const dirtyFiles = rows.filter(
    (r) => !(r.head === 1 && r.workdir === 1 && r.stage === 1),
  ).length;
  let headSha: string | null = null;
  try {
    headSha = await git.resolveRef({ fs, dir: DIR, ref: 'HEAD' });
  } catch {
    headSha = null;
  }
  return { branch, dirtyFiles, headSha };
}

/** Create or switch to a feature branch (never a protected default branch). */
export async function checkoutWorkspaceBranch(branch: string): Promise<{ branch: string }> {
  validateFeatureBranch(branch);
  await ensureRepo();
  const { fs } = services();

  const remoteMainOid = await fetchWorkspaceRemoteDefaultBranch();
  const defaultBranch = resolveWorkspaceRemoteLink()?.defaultBranch ?? 'main';
  const remoteRef = remoteMainOid ? `refs/remotes/origin/${defaultBranch}` : null;

  try {
    await git.resolveRef({ fs, dir: DIR, ref: `refs/heads/${branch}` });
    await git.checkout({ fs, dir: DIR, ref: branch });
  } catch {
    if (remoteRef) {
      try {
        await git.resolveRef({ fs, dir: DIR, ref: remoteRef });
        await git.branch({ fs, dir: DIR, ref: branch, checkout: true, object: remoteRef });
      } catch {
        await git.branch({ fs, dir: DIR, ref: branch, checkout: true });
      }
    } else {
      await git.branch({ fs, dir: DIR, ref: branch, checkout: true });
    }
  }
  // Branch switch rewrites the working tree — re-sync the store mirror
  // + preview so the UI shows the checked-out content without a reload.
  await resyncWorkspaceMirror();
  return { branch };
}

/** Stage all tracked changes and commit on the current branch. */
export async function commitWorkspace(
  message: string,
): Promise<{ sha: string } | { clean: true }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('Commit message is required.');
  await ensureRepo();
  const { svc } = services();
  const rows = await svc.status(DIR);
  const dirty = rows.some((r) => !(r.head === 1 && r.workdir === 1 && r.stage === 1));
  if (!dirty) return { clean: true };
  await svc.stageAll(DIR);
  const author = await resolveGitCommitAuthor();
  const sha = await svc.commit({
    dir: DIR,
    message: trimmed,
    authorName: author.name,
    authorEmail: author.email,
  });
  return { sha };
}
