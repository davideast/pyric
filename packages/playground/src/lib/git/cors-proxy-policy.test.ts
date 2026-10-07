/**
 * The GitHub token must never travel through the public CORS proxy.
 * The attack tests drive the real isomorphic-git client against a stubbed
 * `fetch` that records every request, and assert what reached the proxy.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as git from 'isomorphic-git';

import { WORKSPACE_ROOT } from '~/lib/store/files';
import { useGithubSessionStore } from '~/lib/store/github-session';
import { getVFS, resetVFS } from '~/lib/vfs';

import {
  CorsProxyRefusedError,
  PUBLIC_CORS_PROXY,
  authForProxy,
  corsProxyForCredentials,
  corsProxyForOptionalCredentials,
  isPublicCorsProxy,
} from './cors-proxy-policy';
import { GitService } from './git-service';
import { pushBranchToGitHub } from './push-branch';
import { fetchWorkspaceRemoteDefaultBranch } from './workspace-github-remote';

const TOKEN = 'ghp_secret_token_value';
const REAL_GIT = { ...git };
const REAL_FETCH = globalThis.fetch;

interface Seen {
  url: string;
  authorization: string | null;
}
let seen: Seen[];

function stubFetch(respond: (url: string, auth: string | null) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get('authorization');
    seen.push({ url, authorization: auth });
    return respond(url, auth);
  }) as typeof fetch;
}

function challenge(): Response {
  return new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="GitHub"' } });
}

function tokenReached(host: string): boolean {
  return seen.some((s) => s.url.includes(host) && s.authorization !== null);
}

beforeEach(() => {
  resetVFS();
  seen = [];
  delete process.env.PUBLIC_GIT_CORS_PROXY;
  useGithubSessionStore.getState().setLinkedRepo(null);
  mock.module('./github-auth', () => ({ getStoredPAT: async () => TOKEN }));
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.PUBLIC_GIT_CORS_PROXY;
  mock.module('isomorphic-git', () => REAL_GIT);
  mock.restore();
});

describe('proxy policy', () => {
  test('recognizes the public proxy by host', () => {
    expect(isPublicCorsProxy(PUBLIC_CORS_PROXY)).toBe(true);
    expect(isPublicCorsProxy('https://CORS.isomorphic-git.org/')).toBe(true);
    expect(isPublicCorsProxy('https://proxy.example.com')).toBe(false);
  });

  test('a token request refuses the public proxy and an unconfigured proxy', () => {
    expect(() => corsProxyForCredentials(PUBLIC_CORS_PROXY)).toThrow(CorsProxyRefusedError);
    expect(() => corsProxyForCredentials()).toThrow(/PUBLIC_GIT_CORS_PROXY/);
  });

  test('a token request accepts a configured proxy and an explicit direct request', () => {
    expect(corsProxyForCredentials('https://proxy.example.com')).toBe('https://proxy.example.com');
    expect(corsProxyForCredentials('')).toBe('');
    process.env.PUBLIC_GIT_CORS_PROXY = 'https://configured.example.com';
    expect(corsProxyForCredentials()).toBe('https://configured.example.com');
  });

  test('an anonymous request may fall back to the public proxy', () => {
    expect(corsProxyForOptionalCredentials()).toBe(PUBLIC_CORS_PROXY);
  });

  test('authForProxy refuses to answer a challenge on the public proxy', async () => {
    const creds = async () => ({ username: TOKEN, password: 'x-oauth-basic' });
    await expect(authForProxy(PUBLIC_CORS_PROXY, creds)()).rejects.toBeInstanceOf(
      CorsProxyRefusedError,
    );
    await expect(authForProxy('https://proxy.example.com', creds)()).resolves.toEqual({
      username: TOKEN,
      password: 'x-oauth-basic',
    });
  });
});

describe('the token does not reach the public proxy', () => {
  test('clone: a private repo challenge through the default proxy is not answered', async () => {
    stubFetch(() => challenge());
    const service = new GitService(getVFS());
    await expect(
      service.clone({ url: 'https://github.com/acme/private.git', dir: '/clone' }),
    ).rejects.toThrow(/not sent through the public CORS proxy/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.url.startsWith(PUBLIC_CORS_PROXY))).toBe(true);
    expect(tokenReached('cors.isomorphic-git.org')).toBe(false);
  });

  test('clone: the same challenge through a configured proxy is answered with the token', async () => {
    stubFetch(() => challenge());
    const service = new GitService(getVFS());
    await service
      .clone({
        url: 'https://github.com/acme/private.git',
        dir: '/clone',
        corsProxy: 'https://proxy.example.com',
      })
      .catch(() => undefined);
    expect(tokenReached('proxy.example.com')).toBe(true);
    expect(tokenReached('cors.isomorphic-git.org')).toBe(false);
  });

  test('push: refuses before any request when only the public proxy is available', async () => {
    stubFetch(() => challenge());
    const service = new GitService(getVFS());
    await expect(service.push({ dir: '/repo' })).rejects.toBeInstanceOf(CorsProxyRefusedError);
    await expect(
      service.push({ dir: '/repo', corsProxy: PUBLIC_CORS_PROXY }),
    ).rejects.toBeInstanceOf(CorsProxyRefusedError);
    expect(seen).toEqual([]);
  });

  test('pushBranchToGitHub: refuses before any request without a configured proxy', async () => {
    stubFetch(() => challenge());
    await expect(pushBranchToGitHub({ repo: 'acme/app', branch: 'feat/x' })).rejects.toThrow(
      /PUBLIC_GIT_CORS_PROXY/,
    );
    expect(seen).toEqual([]);
  });

  test('fetching the linked default branch refuses before any request without a configured proxy', async () => {
    stubFetch(() => challenge());
    await getVFS().promises.mkdir(WORKSPACE_ROOT, { recursive: true });
    await expect(
      fetchWorkspaceRemoteDefaultBranch(WORKSPACE_ROOT, {
        cloneUrl: 'https://github.com/acme/app.git',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow(/PUBLIC_GIT_CORS_PROXY/);
    expect(seen).toEqual([]);
  });
});
