import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { createPullRequest, createRepository, findOpenPullRequest } from './github-api';

const REPO = 'acme/firebase-app';
const HEAD = 'feat/playground-rules';

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url.includes('/repos/acme/firebase-app') && !url.includes('/pulls')) {
      return new Response(
        JSON.stringify({
          full_name: REPO,
          default_branch: 'main',
          permissions: { push: true },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/pulls?')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith('/pulls') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          number: 42,
          html_url: 'https://github.com/acme/firebase-app/pull/42',
          url: 'https://api.github.com/repos/acme/firebase-app/pulls/42',
          title: 'Add rules',
          state: 'open',
        }),
        { status: 201 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe('createPullRequest', () => {
  test('rejects protected head branch', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    await expect(
      createPullRequest({ repo: REPO, head: 'main', title: 'nope' }),
    ).rejects.toThrow(/protected/);
  });

  test('creates PR with default base from repo metadata', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    const result = await createPullRequest({
      repo: REPO,
      head: HEAD,
      title: 'Add playground rules',
      body: 'All tests green.',
    });
    expect(result.number).toBe(42);
    expect(result.htmlUrl).toContain('/pull/42');
    expect(result.alreadyExists).toBe(false);
    const post = fetchCalls.find((c) => c.init?.method === 'POST');
    expect(post).toBeDefined();
    const body = JSON.parse(String(post!.init!.body));
    expect(body.head).toBe(HEAD);
    expect(body.base).toBe('main');
  });

  test('returns existing open PR idempotently', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/repos/acme/firebase-app') && !url.includes('/pulls')) {
        return new Response(
          JSON.stringify({
            full_name: REPO,
            default_branch: 'main',
            permissions: { push: true },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/pulls?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              html_url: 'https://github.com/acme/firebase-app/pull/7',
              url: 'https://api.github.com/repos/acme/firebase-app/pulls/7',
              title: 'Existing',
              state: 'open',
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const result = await createPullRequest({
      repo: REPO,
      head: HEAD,
      title: 'ignored',
    });
    expect(result.alreadyExists).toBe(true);
    expect(result.number).toBe(7);
  });
});

describe('findOpenPullRequest', () => {
  test('queries with owner:head filter', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      expect(url).toContain('head=acme%3Afeat%2Fplayground-rules');
      expect(url).toContain('base=main');
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const found = await findOpenPullRequest({ repo: REPO, head: HEAD, base: 'main' });
    expect(found).toBeNull();
  });
});

describe('createRepository', () => {
  test('rejects invalid repo name before network', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    await expect(
      createRepository({ name: '.hidden', visibility: 'public' }),
    ).rejects.toThrow(/cannot start/);
  });

  test('rejects missing PAT', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => null,
    }));
    await expect(
      createRepository({ name: 'firebase-app', visibility: 'public' }),
    ).rejects.toThrow(/Settings → github/);
  });

  test('creates private repo with auto_init true', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/user') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      if (url.endsWith('/user/repos') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.name).toBe('firebase-app');
        expect(body.private).toBe(true);
        expect(body.auto_init).toBe(true);
        return new Response(
          JSON.stringify({
            full_name: 'octocat/firebase-app',
            html_url: 'https://github.com/octocat/firebase-app',
            clone_url: 'https://github.com/octocat/firebase-app.git',
            default_branch: 'main',
            private: true,
          }),
          { status: 201 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const result = await createRepository({
      name: 'firebase-app',
      visibility: 'private',
      description: 'Playground rules',
    });
    expect(result.fullName).toBe('octocat/firebase-app');
    expect(result.private).toBe(true);
  });

  test('maps 422 name collision to actionable error', async () => {
    mock.module('./github-auth', () => ({
      getStoredPAT: async () => 'ghp_test',
    }));
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/user') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      if (url.endsWith('/user/repos') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }),
          { status: 422 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    await expect(
      createRepository({ name: 'firebase-app', visibility: 'public' }),
    ).rejects.toThrow(/octocat\/firebase-app.*github_push_branch/);
  });
});
