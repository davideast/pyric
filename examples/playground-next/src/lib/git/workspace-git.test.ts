import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as git from 'isomorphic-git';

import { WORKSPACE_ROOT } from '~/lib/store/files';
import { useGithubSessionStore } from '~/lib/store/github-session';
import { getVFS, resetVFS } from '~/lib/vfs';

import {
  checkoutWorkspaceBranch,
  commitWorkspace,
  getWorkspaceGitStatus,
} from './workspace-git';

beforeEach(() => {
  resetVFS();
  useGithubSessionStore.getState().setLinkedRepo(null);
});

afterEach(() => {
  resetVFS();
  useGithubSessionStore.getState().setLinkedRepo(null);
});

describe('workspace-git', () => {
  test('checkout, commit, and status on feature branch', async () => {
    const vfs = getVFS();
    await vfs.promises.mkdir(WORKSPACE_ROOT, { recursive: true });
    await git.init({ fs: { promises: vfs.promises }, dir: WORKSPACE_ROOT, defaultBranch: 'main' });
    await vfs.promises.writeFile(`${WORKSPACE_ROOT}/firestore.rules`, 'rules_version = "2";');

    await checkoutWorkspaceBranch('feat/demo');
    const commit = await commitWorkspace('feat: initial rules');
    expect('sha' in commit).toBe(true);

    const status = await getWorkspaceGitStatus();
    expect(status.branch).toBe('feat/demo');
    expect(status.dirtyFiles).toBe(0);
    expect(status.headSha).toBeTruthy();
  });

  test('rejects protected branch checkout', async () => {
    await expect(checkoutWorkspaceBranch('main')).rejects.toThrow(/protected/);
  });
});
