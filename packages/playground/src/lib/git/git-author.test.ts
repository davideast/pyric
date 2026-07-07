import { describe, expect, test } from 'bun:test';

import { authorFromGitHubUser } from './git-author';

describe('authorFromGitHubUser', () => {
  test('uses display name and public email when present', () => {
    expect(
      authorFromGitHubUser({
        id: 1,
        login: 'octocat',
        name: 'The Octocat',
        email: 'octocat@github.com',
        avatarUrl: null,
      }),
    ).toEqual({ name: 'The Octocat', email: 'octocat@github.com' });
  });

  test('falls back to login and GitHub noreply email', () => {
    expect(
      authorFromGitHubUser({
        id: 42,
        login: 'davideast',
        name: null,
        email: null,
        avatarUrl: null,
      }),
    ).toEqual({
      name: 'davideast',
      email: '42+davideast@users.noreply.github.com',
    });
  });
});
