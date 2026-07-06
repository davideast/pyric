/**
 * `github_push_branch` — push a local feature branch to GitHub.
 * Browser-only (PAT in IndexedDB). Mutating, not parallelSafe.
 */
import type { ToolHandler } from '@inbrowser/agent';

import { pushBranchToGitHub, type PushBranchResult } from '~/lib/git/push-branch';
import { resolvePublishRepo } from '~/lib/git/linked-repo';
import { WORKSPACE_ROOT } from '~/lib/store/files';

export interface GitHubPushBranchArgs {
  repo: string;
  branch: string;
  dir?: string;
}

export const githubPushBranchHandler: ToolHandler<
  GitHubPushBranchArgs,
  PushBranchResult
> = {
  name: 'github_push_branch',
  parallelSafe: false,
  description:
    'Push a LOCAL feature branch to GitHub. Requires a PAT in Settings → github with repo scope. Args: `repo` (`owner/name` — omit when this session has a linked repo), `branch` (must already exist locally with commits). Optional `dir` (git root, default `/workspace`). BLOCKED: default/protected branches. Does NOT commit — use workspace_git first. After success, open a PR with `github_create_pull_request`.',
  parameters: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description:
          'GitHub repository as owner/name. Omit when the session has a linked repo (see LINKED GITHUB REPO).',
      },
      branch: {
        type: 'string',
        description:
          'Local feature branch to push (same name on remote). Must exist at `dir`.',
      },
      dir: {
        type: 'string',
        description: `Git working tree root. Defaults to ${WORKSPACE_ROOT}.`,
      },
    },
    required: ['branch'],
  },
  async execute(args) {
    const resolved = resolvePublishRepo(args.repo);
    if (!resolved.ok) {
      return {
        ok: false,
        summary: `github_push_branch · failed: ${resolved.message}`,
        data: { repo: args.repo ?? '', branch: args.branch, url: '' },
      };
    }
    try {
      const result = await pushBranchToGitHub({
        repo: resolved.repo,
        branch: args.branch,
        dir: args.dir,
      });
      return {
        ok: true,
        summary: `github_push_branch · ${result.repo}@${result.branch} → ${result.url}`,
        data: result,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        summary: `github_push_branch · failed: ${message}`,
        data: { repo: args.repo, branch: args.branch, url: '' },
      };
    }
  },
};
