/**
 * Minimal GitHub REST API wrapper used by the playground's git UI to
 * surface the repos a stored PAT has access to. Calls go directly
 * from the browser — GitHub's API serves CORS for any origin and
 * accepts PATs via the `Authorization: Bearer` header.
 */

import {
  assertHeadNotBase,
  parseRepoFullName,
  validateFeatureBranch,
  validateRepoName,
} from './branch-policy';
import { getStoredPAT } from './github-auth';

const GITHUB_API = 'https://api.github.com';

export interface GitHubRepoSummary {
  /** `owner/name`, e.g. `octocat/Hello-World`. */
  fullName: string;
  /** HTTPS clone URL — the form isomorphic-git expects. */
  cloneUrl: string;
  /** True if the repo is private. */
  private: boolean;
  /** Default branch name (used as a hint when cloning). */
  defaultBranch: string;
  /** Push permission for the authenticated user, when GitHub reports it. */
  canPush: boolean;
  /** ISO timestamp of last push — used to order the dropdown. */
  pushedAt: string | null;
}

export interface GitHubUserSummary {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

type GhRepo = {
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  permissions?: { push?: boolean };
};

async function ghFetch<T>(
  path: string,
  token: string,
  init?: { method?: string; body?: string },
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
  return (await res.json()) as T;
}

/**
 * List repos the stored PAT can see. Sorted by most-recently-pushed,
 * capped at the first page (100 entries) — enough to drive a dropdown
 * for the common case; the URL field stays for the long tail.
 */
export async function listAccessibleRepos(): Promise<GitHubRepoSummary[]> {
  const token = await getStoredPAT();
  if (!token) throw new Error('No GitHub PAT stored');
  const repos = await ghFetch<GhRepo[]>(
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    token,
  );
  return repos.map((r) => ({
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    private: r.private,
    defaultBranch: r.default_branch,
    canPush: r.permissions?.push ?? false,
    pushedAt: r.pushed_at,
  }));
}

export interface GitHubRepoDetails {
  fullName: string;
  defaultBranch: string;
  canPush: boolean;
}

type GhRepoDetail = {
  full_name: string;
  default_branch: string;
  permissions?: { push?: boolean };
};

/** Fetch one repo's default branch and push permission for the stored PAT. */
export async function getRepoDetails(fullName: string): Promise<GitHubRepoDetails> {
  const { owner, name } = parseRepoFullName(fullName);
  const token = await getStoredPAT();
  if (!token) throw new Error('No GitHub PAT stored');
  const repo = await ghFetch<GhRepoDetail>(`/repos/${owner}/${name}`, token);
  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    canPush: repo.permissions?.push ?? false,
  };
}

export interface PullRequestSummary {
  number: number;
  url: string;
  htmlUrl: string;
  title: string;
  state: string;
}

type GhPull = {
  number: number;
  html_url: string;
  url: string;
  title: string;
  state: string;
};

/** Return an open PR for head→base when one already exists. */
export async function findOpenPullRequest(opts: {
  repo: string;
  head: string;
  base: string;
}): Promise<PullRequestSummary | null> {
  const { owner, name } = parseRepoFullName(opts.repo);
  const token = await getStoredPAT();
  if (!token) throw new Error('No GitHub PAT stored');
  const headParam = `${owner}:${opts.head}`;
  const pulls = await ghFetch<GhPull[]>(
    `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(headParam)}&base=${encodeURIComponent(opts.base)}`,
    token,
  );
  const pr = pulls[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    htmlUrl: pr.html_url,
    title: pr.title,
    state: pr.state,
  };
}

export interface CreatePullRequestInput {
  repo: string;
  title: string;
  head: string;
  base?: string;
  body?: string;
  draft?: boolean;
}

export interface CreatePullRequestResult extends PullRequestSummary {
  alreadyExists: boolean;
}

/** Open a pull request (idempotent when an open PR already exists). */
export async function createPullRequest(
  input: CreatePullRequestInput,
): Promise<CreatePullRequestResult> {
  parseRepoFullName(input.repo);
  validateFeatureBranch(input.head);
  const token = await getStoredPAT();
  if (!token) {
    throw new Error(
      'No GitHub personal access token configured. Add one in Settings → github.',
    );
  }

  const repo = await getRepoDetails(input.repo);
  if (!repo.canPush) {
    throw new Error(`No push permission for ${input.repo} — check your PAT scopes.`);
  }

  const base = input.base?.trim() || repo.defaultBranch;
  assertHeadNotBase(input.head, base);

  const existing = await findOpenPullRequest({ repo: input.repo, head: input.head, base });
  if (existing) {
    return { ...existing, alreadyExists: true };
  }

  const { owner, name } = parseRepoFullName(input.repo);
  const title = input.title.trim();
  if (!title) throw new Error('Pull request title is required.');

  try {
    const pr = await ghFetch<GhPull>(`/repos/${owner}/${name}/pulls`, token, {
      method: 'POST',
      body: JSON.stringify({
        title,
        head: input.head,
        base,
        body: input.body ?? '',
        draft: input.draft ?? false,
      }),
    });
    return {
      number: pr.number,
      url: pr.url,
      htmlUrl: pr.html_url,
      title: pr.title,
      state: pr.state,
      alreadyExists: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('422') && message.toLowerCase().includes('already exists')) {
      const again = await findOpenPullRequest({ repo: input.repo, head: input.head, base });
      if (again) return { ...again, alreadyExists: true };
    }
    if (message.includes('422') && message.toLowerCase().includes('head')) {
      throw new Error(
        `Branch "${input.head}" is not on GitHub yet — push it first with github_push_branch.`,
      );
    }
    throw e;
  }
}

/** Fetch the authenticated user. Used to pre-fill name/email defaults. */
export async function getAuthenticatedUser(): Promise<GitHubUserSummary> {
  const token = await getStoredPAT();
  if (!token) throw new Error('No GitHub PAT stored');
  const user = await ghFetch<{
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  }>('/user', token);
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url,
  };
}

export interface CreateRepositoryInput {
  name: string;
  visibility: 'public' | 'private';
  description?: string;
}

export interface CreateRepositoryResult {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

type GhCreatedRepo = {
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
};

/** Create an empty user-owned repository under the authenticated account. */
export async function createRepository(
  input: CreateRepositoryInput,
): Promise<CreateRepositoryResult> {
  validateRepoName(input.name);
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    throw new Error('visibility must be "public" or "private".');
  }

  const token = await getStoredPAT();
  if (!token) {
    throw new Error(
      'No GitHub personal access token configured. Add one in Settings → github.',
    );
  }

  const user = await getAuthenticatedUser();
  const repoName = input.name.trim();

  try {
    const repo = await ghFetch<GhCreatedRepo>('/user/repos', token, {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: input.visibility === 'private',
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        auto_init: true,
      }),
    });
    return {
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('422') && message.toLowerCase().includes('already exists')) {
      throw new Error(
        `Repo "${user.login}/${repoName}" already exists — use github_push_branch instead.`,
      );
    }
    throw e;
  }
}
