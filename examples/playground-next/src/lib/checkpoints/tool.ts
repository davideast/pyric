/**
 * `workspace_checkpoints` — agent surface over the checkpoint service
 * (W3.1). Always-on beside CORE_TOOLS. Mutating (revert rewrites the
 * working tree), so NOT parallelSafe.
 */
import type { ToolHandler } from '@inbrowser/agent';

import {
  listCheckpoints,
  revertToCheckpoint,
  type Checkpoint,
  type RevertResult,
} from './service';

export interface WorkspaceCheckpointsArgs {
  action: 'list' | 'revert';
  sha?: string;
}

export type WorkspaceCheckpointsData =
  | { action: 'list'; checkpoints: Checkpoint[] }
  | ({ action: 'revert' } & RevertResult)
  | { reason: string };

export const workspaceCheckpointsHandler: ToolHandler<
  WorkspaceCheckpointsArgs,
  WorkspaceCheckpointsData
> = {
  name: 'workspace_checkpoints',
  parallelSafe: false,
  description:
    'List or revert workspace git checkpoints. Checkpoints are AUTO-CREATED whenever `run_workspace_tests` reports an all-green suite — each one is a known-good snapshot of /workspace, so breaking changes are always one revert away. `{action:"list"}` returns recent checkpoints `{sha, label, when}` (newest first). `{action:"revert", sha}` hard-restores all TRACKED workspace files to that checkpoint: modified files are overwritten, files added since are removed, deleted files come back; UNTRACKED files (never part of a checkpoint) are left alone. The revert is recorded as a new checkpoint — history is append-only, so a revert can itself be reverted. After reverting, re-run `run_workspace_tests` to confirm the restored state is green.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'revert'],
        description: '`list` recent checkpoints, or `revert` to one.',
      },
      sha: {
        type: 'string',
        description:
          'Checkpoint commit sha (full or abbreviated). Required for `revert`; get it from `list`.',
      },
    },
    required: ['action'],
  },
  async execute({ action, sha }) {
    if (action === 'list') {
      const checkpoints = await listCheckpoints();
      if (checkpoints.length === 0) {
        return {
          ok: true,
          summary:
            'workspace_checkpoints · none yet — checkpoints are created automatically when run_workspace_tests goes green',
          data: { action: 'list', checkpoints },
        };
      }
      return {
        ok: true,
        summary: `workspace_checkpoints · ${checkpoints.length} checkpoint(s) · latest: ${checkpoints[0]!.label} (${checkpoints[0]!.sha.slice(0, 7)})`,
        data: { action: 'list', checkpoints },
      };
    }
    // action === 'revert'
    if (!sha) {
      return {
        ok: false,
        summary:
          'workspace_checkpoints · revert requires `sha` — call {action:"list"} first',
        data: { reason: 'missing sha' },
      };
    }
    try {
      const result = await revertToCheckpoint(sha);
      return {
        ok: true,
        summary: `workspace_checkpoints · restored /workspace to ${result.restored.slice(0, 7)}${result.commit ? ` · recorded as ${result.commit.slice(0, 7)}` : ' · workspace already matched (no new commit)'}`,
        data: { action: 'revert', ...result },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        summary: `workspace_checkpoints · revert failed: ${message}`,
        data: { reason: message },
      };
    }
  },
};
