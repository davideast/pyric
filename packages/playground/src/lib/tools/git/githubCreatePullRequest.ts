/**
 * `github_create_pull_request` — open a PR on GitHub after the branch
 * is pushed. Browser-only REST (PAT in IndexedDB). Not parallelSafe.
 */
import type { ToolHandler } from '@inbrowser/agent';

import {
  createPullRequest,
  type CreatePullRequestResult,
} from '~/lib/git/github-api';
import { resolvePublishRepo } from '~/lib/git/linked-repo';

export interface GitHubCreatePullRequestArgs {
  repo: string;
  head: string;
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

export const githubCreatePullRequestHandler: ToolHandler<
  GitHubCreatePullRequestArgs,
  CreatePullRequestResult
> = {
  name: 'github_create_pull_request',
  parallelSafe: false,
  description:
    'Open a GitHub pull request from a pushed feature branch. Requires PAT in Settings → github. Args: `repo` (`owner/name`), `head` (feature branch — must already exist on GitHub; push with `github_push_branch` first), `title`, optional `body` (markdown), optional `base` (defaults to the repo default branch), optional `draft` (default false). BLOCKED: protected heads (`main`, `master`, …). CREATE only — does not merge or close PRs. Idempotent: returns the existing open PR URL when head→base already has one.',
  parameters: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description:
          'GitHub repository as owner/name. Omit when the session has a linked repo.',
      },
      head: {
        type: 'string',
        description: 'Feature branch name (the PR source). Must be on GitHub already.',
      },
      title: {
        type: 'string',
        description: 'Pull request title.',
      },
      body: {
        type: 'string',
        description: 'Optional markdown description.',
      },
      base: {
        type: 'string',
        description: 'Target branch. Defaults to the repo default branch (usually main).',
      },
      draft: {
        type: 'boolean',
        description: 'Open as draft PR when true.',
      },
    },
    required: ['head', 'title'],
  },
  async execute(args) {
    const resolved = resolvePublishRepo(args.repo);
    if (!resolved.ok) {
      return {
        ok: false,
        summary: `github_create_pull_request · failed: ${resolved.message}`,
        data: {
          number: 0,
          url: '',
          htmlUrl: '',
          title: args.title,
          state: 'failed',
          alreadyExists: false,
        },
      };
    }
    try {
      const result = await createPullRequest({
        repo: resolved.repo,
        head: args.head,
        title: args.title,
        body: args.body,
        base: args.base,
        draft: args.draft,
      });
      const note = result.alreadyExists ? ' (existing open PR)' : '';
      return {
        ok: true,
        summary: `github_create_pull_request · #${result.number}${note} · ${result.htmlUrl}`,
        data: result,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        summary: `github_create_pull_request · failed: ${message}`,
        data: {
          number: 0,
          url: '',
          htmlUrl: '',
          title: args.title,
          state: 'failed',
          alreadyExists: false,
        },
      };
    }
  },
};
