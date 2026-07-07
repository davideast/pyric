import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useGithubSessionStore } from '~/lib/store/github-session';

import { assertNoLinkedRepoForCreate, resolvePublishRepo } from './linked-repo';

const LINKED = {
  fullName: 'octocat/firebase-app',
  htmlUrl: 'https://github.com/octocat/firebase-app',
  cloneUrl: 'https://github.com/octocat/firebase-app.git',
  defaultBranch: 'main',
  private: true,
  linkedAt: 1,
};

function resetLinkedRepo() {
  useGithubSessionStore.getState().setLinkedRepo(null);
}

beforeEach(resetLinkedRepo);
afterEach(resetLinkedRepo);

describe('resolvePublishRepo', () => {
  test('uses linked repo when present', () => {
    useGithubSessionStore.getState().setLinkedRepo(LINKED);
    expect(resolvePublishRepo()).toEqual({ ok: true, repo: 'octocat/firebase-app' });
  });

  test('rejects mismatched repo when linked', () => {
    useGithubSessionStore.getState().setLinkedRepo(LINKED);
    const result = resolvePublishRepo('other/wrong');
    expect(result.ok).toBe(false);
  });

  test('requires explicit repo when not linked', () => {
    expect(resolvePublishRepo()).toEqual({
      ok: false,
      message: expect.stringMatching(/No linked GitHub repo/),
    });
  });
});

describe('assertNoLinkedRepoForCreate', () => {
  test('blocks create when linked', () => {
    useGithubSessionStore.getState().setLinkedRepo(LINKED);
    expect(assertNoLinkedRepoForCreate().ok).toBe(false);
  });
});
