import { describe, expect, test } from 'bun:test';

import {
  canStartWithGitHubRepo,
  formatGitHubRepoPreview,
  githubStartBlockReason,
} from './GitHubRepoSetup';

describe('formatGitHubRepoPreview', () => {
  test('uses login when known', () => {
    expect(formatGitHubRepoPreview('octocat', 'my-app')).toBe('github.com/octocat/my-app');
  });

  test('uses placeholder account when login unknown', () => {
    expect(formatGitHubRepoPreview(null, 'my-app')).toBe('github.com/your-account/my-app');
  });

  test('shows placeholder slug when name empty', () => {
    expect(formatGitHubRepoPreview('octocat', '')).toBe('github.com/octocat/repo-name');
  });
});

describe('githubStartBlockReason', () => {
  test('returns null when repo creation disabled', () => {
    expect(
      githubStartBlockReason({ createRepo: false, repoName: '', patPresent: false }),
    ).toBeNull();
  });

  test('requires repo name', () => {
    expect(
      githubStartBlockReason({ createRepo: true, repoName: '  ', patPresent: true }),
    ).toMatch(/Name your repo/);
  });

  test('requires PAT when missing', () => {
    expect(
      githubStartBlockReason({ createRepo: true, repoName: 'my-app', patPresent: false }),
    ).toMatch(/GitHub token/);
  });

  test('allows start when configured', () => {
    expect(
      githubStartBlockReason({ createRepo: true, repoName: 'my-app', patPresent: true }),
    ).toBeNull();
    expect(canStartWithGitHubRepo({ createRepo: true, repoName: 'my-app', patPresent: true })).toBe(
      true,
    );
  });
});
