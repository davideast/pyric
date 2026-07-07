/**
 * Link /workspace git history to the session's GitHub repo so feature
 * branches share a common ancestor with remote main (required for PRs).
 */
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

import { ensureBufferPolyfill } from './buffer-polyfill';
import { resolveGitCommitAuthor } from './git-author';
import { getLinkedGitHubRepo } from './linked-repo';
import { getStoredPAT } from './github-auth';
import { normalizedAdapter } from './normalized-fs';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

const DEFAULT_CORS_PROXY = 'https://cors.isomorphic-git.org';

function workspaceFs() {
  ensureBufferPolyfill();
  const adapter = normalizedAdapter(getVFS());
  return { fs: { promises: adapter.promises }, adapter };
}

function githubAuth(token: string) {
  return { username: token, password: 'x-oauth-basic' };
}

export interface WorkspaceRemoteLink {
  cloneUrl: string;
  defaultBranch: string;
}

export function resolveWorkspaceRemoteLink(): WorkspaceRemoteLink | null {
  const linked = getLinkedGitHubRepo();
  if (!linked) return null;
  return {
    cloneUrl: linked.cloneUrl,
    defaultBranch: linked.defaultBranch,
  };
}

/** Ensure origin remote exists and default branch is fetched. */
export async function fetchWorkspaceRemoteDefaultBranch(
  dir = WORKSPACE_ROOT,
  link = resolveWorkspaceRemoteLink(),
): Promise<string | null> {
  if (!link) return null;

  const token = await getStoredPAT();
  if (!token) return null;

  const { fs } = workspaceFs();
  await fs.promises.mkdir(dir, { recursive: true });

  try {
    await fs.promises.stat(`${dir}/.git/HEAD`);
  } catch {
    await git.init({ fs, dir, defaultBranch: link.defaultBranch });
  }

  const remotes = await git.listRemotes({ fs, dir });
  if (!remotes.some((r) => r.remote === 'origin')) {
    await git.addRemote({ fs, dir, remote: 'origin', url: link.cloneUrl });
  }

  await git.fetch({
    fs,
    http,
    dir,
    remote: 'origin',
    ref: link.defaultBranch,
    singleBranch: true,
    depth: 1,
    onAuth: () => githubAuth(token),
    corsProxy: DEFAULT_CORS_PROXY,
  });

  const remoteRef = `refs/remotes/origin/${link.defaultBranch}`;
  try {
    return await git.resolveRef({ fs, dir, ref: remoteRef });
  } catch {
    return null;
  }
}

/** OID of fetched origin/defaultBranch, or null when not linked / no PAT. */
export async function resolveRemoteDefaultBranchOid(
  dir = WORKSPACE_ROOT,
): Promise<{ oid: string; defaultBranch: string } | null> {
  const link = resolveWorkspaceRemoteLink();
  if (!link) return null;
  const oid = await fetchWorkspaceRemoteDefaultBranch(dir, link);
  if (!oid) return null;
  return { oid, defaultBranch: link.defaultBranch };
}

/** Merge origin/default into feature when histories diverged (orphan local init). */
export async function ensureFeatureBranchSharesRemoteHistory(
  featureBranch: string,
  defaultBranch: string,
  dir = WORKSPACE_ROOT,
): Promise<void> {
  const { fs } = workspaceFs();
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  let remoteOid: string;
  try {
    remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef });
  } catch {
    return;
  }

  const featureOid = await git.resolveRef({ fs, dir, ref: `refs/heads/${featureBranch}` });
  if (featureOid === remoteOid) return;

  const shared = await git.isDescendent({ fs, dir, oid: featureOid, ancestor: remoteOid });
  if (shared) return;

  const author = await resolveGitCommitAuthor();
  await git.checkout({ fs, dir, ref: featureBranch });
  await git.merge({
    fs,
    dir,
    ours: featureBranch,
    theirs: remoteRef,
    author: { name: author.name, email: author.email },
    message: `Merge remote-tracking branch 'origin/${defaultBranch}' into ${featureBranch}`,
    allowUnrelatedHistories: true,
  });
}
