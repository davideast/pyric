/**
 * `workspace_git` — local git on /workspace without bash.
 */
import type { ToolHandler } from '@inbrowser/agent';

import {
  checkoutWorkspaceBranch,
  commitWorkspace,
  getWorkspaceGitStatus,
  type WorkspaceGitStatus,
} from '~/lib/git/workspace-git';

export interface WorkspaceGitArgs {
  action: 'status' | 'checkout' | 'commit';
  branch?: string;
  message?: string;
}

export type WorkspaceGitData =
  | ({ action: 'status' } & WorkspaceGitStatus)
  | { action: 'checkout'; branch: string }
  | { action: 'commit'; sha: string }
  | { action: 'commit'; clean: true }
  | { reason: string };

export const workspaceGitHandler: ToolHandler<WorkspaceGitArgs, WorkspaceGitData> = {
  name: 'workspace_git',
  parallelSafe: false,
  description:
    'Local git on /workspace via isomorphic-git — there is NO `git` in bash. Use this BEFORE `github_push_branch`. Actions: `status` (branch, dirty file count, HEAD sha), `checkout` (create/switch to a feature branch — not main/master), `commit` (stage all + commit with `message`). Publish flow: checkout feature branch → commit → `github_push_branch` → `github_create_pull_request`. Only report publish success when those GitHub tools return ok:true with URLs.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'checkout', 'commit'],
      },
      branch: {
        type: 'string',
        description: 'Feature branch name for `checkout` (e.g. feat/my-app).',
      },
      message: {
        type: 'string',
        description: 'Commit message for `commit`.',
      },
    },
    required: ['action'],
  },
  async execute({ action, branch, message }) {
    try {
      if (action === 'status') {
        const status = await getWorkspaceGitStatus();
        return {
          ok: true,
          summary: `workspace_git · on ${status.branch}${status.headSha ? ` @ ${status.headSha.slice(0, 7)}` : ' (no commits yet)'} · ${status.dirtyFiles} dirty file(s)`,
          data: { action: 'status', ...status },
        };
      }
      if (action === 'checkout') {
        if (!branch?.trim()) {
          return {
            ok: false,
            summary: 'workspace_git · checkout requires `branch`',
            data: { reason: 'missing branch' },
          };
        }
        const result = await checkoutWorkspaceBranch(branch.trim());
        return {
          ok: true,
          summary: `workspace_git · checked out ${result.branch}`,
          data: { action: 'checkout', branch: result.branch },
        };
      }
      if (!message?.trim()) {
        return {
          ok: false,
          summary: 'workspace_git · commit requires `message`',
          data: { reason: 'missing message' },
        };
      }
      const result = await commitWorkspace(message);
      if ('clean' in result) {
        return {
          ok: true,
          summary: 'workspace_git · working tree clean — nothing to commit',
          data: { action: 'commit', clean: true },
        };
      }
      return {
        ok: true,
        summary: `workspace_git · committed ${result.sha.slice(0, 7)}`,
        data: { action: 'commit', sha: result.sha },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        summary: `workspace_git · ${action} failed: ${msg}`,
        data: { reason: msg },
      };
    }
  },
};
