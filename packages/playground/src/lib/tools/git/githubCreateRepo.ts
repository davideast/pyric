/**
 * `github_create_repo` — create an empty user-owned GitHub repository.
 * Browser-only REST (PAT in IndexedDB). Not parallelSafe.
 */
import type { ToolHandler } from '@inbrowser/agent';

import {
  createRepository,
  type CreateRepositoryResult,
} from '~/lib/git/github-api';
import { assertNoLinkedRepoForCreate } from '~/lib/git/linked-repo';

export interface GitHubCreateRepoArgs {
  name: string;
  description?: string;
}

export const githubCreateRepoHandler: ToolHandler<
  GitHubCreateRepoArgs,
  CreateRepositoryResult
> = {
  name: 'github_create_repo',
  parallelSafe: false,
  description:
    'Create an empty GitHub repository under the authenticated user\'s account ONLY when this session has NO linked repo (see LINKED GITHUB REPO in the system prompt). Requires PAT in Settings → github with `repo` scope. Args: `name` (repo name only), optional `description`. Always creates a **private** repo with an initial README on `main` so pull requests have a valid base branch. Do NOT call when a repo is already linked — use github_push_branch instead.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Repository name (not owner/name — created under your GitHub account).',
      },
      description: {
        type: 'string',
        description: 'Optional short repository description.',
      },
    },
    required: ['name'],
  },
  async execute(args) {
    const linkedCheck = assertNoLinkedRepoForCreate();
    if (!linkedCheck.ok) {
      return {
        ok: false,
        summary: `github_create_repo · blocked: ${linkedCheck.message}`,
        data: {
          fullName: '',
          htmlUrl: '',
          cloneUrl: '',
          defaultBranch: '',
          private: true,
        },
      };
    }
    try {
      const result = await createRepository({
        name: args.name,
        visibility: 'private',
        description: args.description,
      });
      return {
        ok: true,
        summary: `github_create_repo · ${result.fullName} (${result.private ? 'private' : 'public'}) · ${result.htmlUrl}`,
        data: result,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        summary: `github_create_repo · failed: ${message}`,
        data: {
          fullName: '',
          htmlUrl: '',
          cloneUrl: '',
          defaultBranch: '',
          private: true,
        },
      };
    }
  },
};
