/**
 * Workspace checkpoint service (W3.1, workstation-architecture.md section Move W3).
 *
 * Treats `/workspace` as a git repository (isomorphic-git over the same
 * OPFS/memory VFS the file tools use, via the existing `GitService`
 * plumbing) and exposes exactly four verbs:
 *
 *   - {@link ensureRepo}          idempotent `git init` at /workspace
 *   - {@link commitCheckpoint}    stage-all + `checkpoint: <label>` commit
 *   - {@link listCheckpoints}     recent checkpoint commits, newest first
 *   - {@link revertToCheckpoint}  hard-restore tracked files to a commit
 *
 * Checkpoints are the agent's safety rail: the host auto-commits after
 * every green `run_workspace_tests` run, so workspace history becomes a
 * sequence of known-good states and "the agent broke it" is one revert away.
 *
 * Revert semantics (deliberate, documented):
 *   - TRACKED files are hard-restored to the target commit's tree —
 *     modified files are overwritten, files tracked since the checkpoint
 *     are deleted, files deleted since the checkpoint come back.
 *   - UNTRACKED files (never committed/staged) are LEFT ALONE. This
 *     matches `git checkout`'s own behavior (isomorphic-git's checkout
 *     ignores workdir-only entries) and is the least destructive choice:
 *     in-flight work the agent hasn't verified yet survives a rollback.
 *   - History is APPEND-ONLY: the restore is recorded as a new
 *     `checkpoint: revert to <short-sha>` commit instead of moving any
 *     ref backwards, so a revert can itself be reverted.
 */
import * as git from 'isomorphic-git';

import { resyncWorkspaceMirror } from '~/lib/files/bootstrap';
import { ensureBufferPolyfill } from '~/lib/git/buffer-polyfill';
import { CHECKPOINT_AUTHOR, resolveGitCommitAuthor } from '~/lib/git/git-author';
import { GitService } from '~/lib/git/git-service';
import { normalizedAdapter } from '~/lib/git/normalized-fs';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

export { CHECKPOINT_AUTHOR };

/** Commit-message prefix that marks a commit as a checkpoint. */
export const CHECKPOINT_PREFIX = 'checkpoint: ';

export interface Checkpoint {
  sha: string;
  label: string;
  /** Commit author timestamp, epoch milliseconds. */
  when: number;
}

export interface RevertResult {
  /** Full oid of the checkpoint that was restored. */
  restored: string;
  /** The new `checkpoint: revert to <short>` commit, or `null` when the
   *  workspace already matched the target tree (nothing to record). */
  commit: string | null;
}

const DIR = WORKSPACE_ROOT;

/** Fresh per call — `resetVFS()` (headless harness isolation) must not
 *  leave a stale adapter captured in a module-level singleton. */
function services(): { svc: GitService; fs: { promises: ReturnType<typeof getVFS>['promises'] } } {
  ensureBufferPolyfill();
  const adapter = normalizedAdapter(getVFS());
  return { svc: new GitService(adapter), fs: { promises: adapter.promises } };
}

/** Initialize a git repo at /workspace if absent. Idempotent — an existing
 *  repo (detected via `.git/HEAD`) is never re-initialized or clobbered. */
export async function ensureRepo(): Promise<void> {
  const { fs } = services();
  await fs.promises.mkdir(DIR, { recursive: true });
  try {
    await fs.promises.stat(`${DIR}/.git/HEAD`);
    return; // already a repo
  } catch {
    // fall through to init
  }
  await git.init({ fs, dir: DIR, defaultBranch: 'main' });
}

/** Stage every change (add/modify/delete) and commit `checkpoint: <label>`.
 *  Returns the new commit sha, or `null` when the working tree is clean
 *  (nothing changed since the last commit — no empty checkpoints). */
export async function commitCheckpoint(label: string): Promise<string | null> {
  await ensureRepo();
  const { svc } = services();
  const rows = await svc.status(DIR);
  const dirty = rows.some((r) => !(r.head === 1 && r.workdir === 1 && r.stage === 1));
  if (!dirty) return null;
  await svc.stageAll(DIR);
  const author = await resolveGitCommitAuthor();
  return svc.commit({
    dir: DIR,
    message: `${CHECKPOINT_PREFIX}${label}`,
    authorName: author.name,
    authorEmail: author.email,
  });
}

/** Recent checkpoint commits, newest first. Non-checkpoint commits (e.g.
 *  user commits made through the Repo tab) are filtered out. */
export async function listCheckpoints(limit = 20): Promise<Checkpoint[]> {
  await ensureRepo();
  const { svc } = services();
  let entries;
  try {
    entries = await svc.log(DIR);
  } catch {
    return []; // empty repo — HEAD doesn't resolve yet
  }
  return entries
    .filter((e) => e.message.startsWith(CHECKPOINT_PREFIX))
    .slice(0, limit)
    .map((e) => ({
      sha: e.oid,
      label: (e.message.split('\n', 1)[0] ?? '').slice(CHECKPOINT_PREFIX.length),
      when: e.timestamp,
    }));
}

/** Hard-restore the workspace to a checkpoint's tree (see module JSDoc for
 *  the tracked/untracked contract), then record the restore as a new
 *  append-only checkpoint commit. Accepts abbreviated shas. */
export async function revertToCheckpoint(sha: string): Promise<RevertResult> {
  await ensureRepo();
  const { fs } = services();
  let oid: string;
  try {
    oid = await git.expandOid({ fs, dir: DIR, oid: sha });
    await git.readCommit({ fs, dir: DIR, oid });
  } catch {
    throw new Error(
      `No commit found for "${sha}" — use workspace_checkpoints {action:"list"} for valid shas.`,
    );
  }
  // Restores workdir + index to the target tree without moving HEAD:
  // tracked files overwritten/deleted/recreated; untracked files ignored.
  await git.checkout({ fs, dir: DIR, ref: oid, force: true, noUpdateHead: true });
  // Bulk working-tree mutation — re-sync the store mirror + preview
  // (rules redeploy, recompile) from the restored files. Without this
  // a rollback left the UI showing pre-rollback content until reload.
  await resyncWorkspaceMirror();
  const commit = await commitCheckpoint(`revert to ${oid.slice(0, 7)}`);
  return { restored: oid, commit };
}
