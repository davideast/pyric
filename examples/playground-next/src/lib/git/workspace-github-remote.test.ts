import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as git from 'isomorphic-git';

import { useGithubSessionStore } from '~/lib/store/github-session';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS, resetVFS } from '~/lib/vfs';

import {
  ensureFeatureBranchSharesRemoteHistory,
  fetchWorkspaceRemoteDefaultBranch,
} from './workspace-github-remote';

const LINKED = {
  fullName: 'octocat/firebase-app',
  htmlUrl: 'https://github.com/octocat/firebase-app',
  cloneUrl: 'https://github.com/octocat/firebase-app.git',
  defaultBranch: 'main',
  private: true,
  linkedAt: 1,
};

beforeEach(() => {
  resetVFS();
  useGithubSessionStore.getState().setLinkedRepo(null);
});

afterEach(() => {
  mock.restore();
});

describe('fetchWorkspaceRemoteDefaultBranch', () => {
  test('returns null when session is not linked', async () => {
    await expect(fetchWorkspaceRemoteDefaultBranch()).resolves.toBeNull();
  });
});

describe('ensureFeatureBranchSharesRemoteHistory', () => {
  test('merges unrelated local history onto fetched origin/main before push', async () => {
    const vfs = getVFS();
    const fs = { promises: vfs.promises };
    const dir = WORKSPACE_ROOT;
    await vfs.promises.mkdir(dir, { recursive: true });
    await git.init({ fs, dir, defaultBranch: 'main' });

    // Orphan workspace history
    await vfs.promises.writeFile(`${dir}/firestore.rules`, 'rules');
    await git.add({ fs, dir, filepath: 'firestore.rules' });
    await git.commit({
      fs,
      dir,
      message: 'orphan local',
      author: { name: 'local', email: 'local@test.dev' },
    });
    await git.branch({ fs, dir, ref: 'feat/demo', checkout: true });
    await vfs.promises.writeFile(`${dir}/src/App.tsx`, 'app');
    await git.add({ fs, dir, filepath: 'src/App.tsx' });
    const featBefore = await git.commit({
      fs,
      dir,
      message: 'feat work',
      author: { name: 'local', email: 'local@test.dev' },
    });

    // Simulated fetched origin/main (separate repo, objects copied in)
    const remoteDir = '/remote';
    await vfs.promises.mkdir(remoteDir, { recursive: true });
    await git.init({ fs, dir: remoteDir, defaultBranch: 'main' });
    await vfs.promises.writeFile(`${remoteDir}/README.md`, '# readme');
    await git.add({ fs, dir: remoteDir, filepath: 'README.md' });
    const remoteMain = await git.commit({
      fs,
      dir: remoteDir,
      message: 'Initial commit',
      author: { name: 'gh', email: 'gh@test.dev' },
    });

    async function copyOid(from: string, to: string, oid: string): Promise<void> {
      try {
        await git.readObject({ fs, dir: to, oid });
        return;
      } catch {
        /* not present yet */
      }
      const { type, object } = await git.readObject({ fs, dir: from, oid });
      if (type === 'commit') {
        const { commit } = await git.readCommit({ fs, dir: from, oid });
        await copyOid(from, to, commit.tree);
      } else if (type === 'tree') {
        const { tree } = await git.readTree({ fs, dir: from, oid });
        for (const entry of tree) {
          await copyOid(from, to, entry.oid);
        }
      }
      await git.writeObject({ fs, dir: to, type, object });
    }
    await copyOid(remoteDir, dir, remoteMain);
    await git.writeRef({ fs, dir, ref: 'refs/remotes/origin/main', value: remoteMain });

    expect(await git.isDescendent({ fs, dir, oid: featBefore, ancestor: remoteMain })).toBe(
      false,
    );

    await ensureFeatureBranchSharesRemoteHistory('feat/demo', 'main', dir);

    const featAfter = await git.resolveRef({ fs, dir, ref: 'refs/heads/feat/demo' });
    expect(await git.isDescendent({ fs, dir, oid: featAfter, ancestor: remoteMain })).toBe(
      true,
    );
  });
});
