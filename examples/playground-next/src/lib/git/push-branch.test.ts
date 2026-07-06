/**
 * pushBranchToGitHub — headless tests with mocked GitHub API + git.push.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as git from 'isomorphic-git';

import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS, resetVFS } from '~/lib/vfs';

import { pushBranchToGitHub } from './push-branch';

const REPO = 'acme/firebase-app';
const BRANCH = 'feat/playground-rules';
const REAL_GIT = { ...git };

beforeEach(() => {
  resetVFS();
});

afterEach(() => {
  mock.module('isomorphic-git', () => REAL_GIT);
  mock.restore();
});

async function seedRepoWithBranch(dir = WORKSPACE_ROOT): Promise<void> {
  const vfs = getVFS();
  await vfs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs: { promises: vfs.promises }, dir, defaultBranch: 'main' });
  await git.branch({ fs: { promises: vfs.promises }, dir, ref: BRANCH, checkout: true });
  await vfs.promises.writeFile(`${dir}/firestore.rules`, 'rules_version = "2";');
  await git.add({ fs: { promises: vfs.promises }, dir, filepath: 'firestore.rules' });
  await git.commit({
    fs: { promises: vfs.promises },
    dir,
    message: 'feat: rules',
    author: { name: 'test', email: 'test@test.dev' },
  });
}

describe('pushBranchToGitHub', () => {
  test('rejects protected branch names before network', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    await expect(pushBranchToGitHub({ repo: REPO, branch: 'main' })).rejects.toThrow(/protected/);
  });

  test('rejects missing PAT', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => null,
    }));
    mock.module('./github-api', () => ({
      getRepoDetails: async () => ({
        fullName: REPO,
        defaultBranch: 'main',
        canPush: true,
      }),
    }));
    await seedRepoWithBranch();
    await expect(pushBranchToGitHub({ repo: REPO, branch: BRANCH })).rejects.toThrow(
      /Settings → github/,
    );
  });

  test('rejects when local branch is missing', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    mock.module('./github-api', () => ({
      getRepoDetails: async () => ({
        fullName: REPO,
        defaultBranch: 'main',
        canPush: true,
      }),
    }));
    await expect(pushBranchToGitHub({ repo: REPO, branch: BRANCH })).rejects.toThrow(
      /does not exist/,
    );
  });

  test('pushes with force:false and matching ref/remoteRef', async () => {
    const pushSpy = mock(async () => ({ ok: ['unpack', BRANCH], errors: [] as string[] }));
    mock.module('isomorphic-git', () => ({
      ...REAL_GIT,
      push: pushSpy,
    }));
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    mock.module('./github-api', () => ({
      getRepoDetails: async () => ({
        fullName: REPO,
        defaultBranch: 'main',
        canPush: true,
      }),
    }));

    const dir = '/push-workspace';
    await seedRepoWithBranch(dir);
    const result = await pushBranchToGitHub({ repo: REPO, branch: BRANCH, dir });

    expect(decodeURIComponent(result.url)).toContain(
      `github.com/${REPO}/tree/${BRANCH}`,
    );
    expect(pushSpy).toHaveBeenCalled();
    const call = pushSpy.mock.calls[0]?.[0] as {
      ref: string;
      remoteRef: string;
      force: boolean;
      url: string;
    };
    expect(call.ref).toBe(BRANCH);
    expect(call.remoteRef).toBe(BRANCH);
    expect(call.force).toBe(false);
    expect(call.url).toBe(`https://github.com/${REPO}.git`);
  });
});
