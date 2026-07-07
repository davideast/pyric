/**
 * `delete_file` — remove a file from the OPFS VFS. Refuses paths in
 * the pinned set (`firestore.rules`, `database.rules.json`) because rules deployment
 * targets a known location; deleting it would silently break the
 * deploy/lint loop until the agent re-creates it.
 */
import type { ToolHandler } from '@inbrowser/agent';

import { notifyVfsWrite } from '~/lib/files/bootstrap';
import { isPinned, WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

export interface DeleteFileArgs {
  path: string;
}

export interface DeleteFileData {
  path: string;
  deleted: boolean;
  reason?: 'PINNED' | 'NOT_FOUND';
}

function assertWithinWorkspace(path: string): void {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`Path must live under ${WORKSPACE_ROOT}/`);
  }
}

export const deleteFileHandler: ToolHandler<DeleteFileArgs, DeleteFileData> = {
  name: 'delete_file',
  description:
    "Remove a file from the OPFS VFS. The path must be under /workspace/. Pinned files (firestore.rules, database.rules.json) can't be deleted — the call returns `{ deleted: false, reason: 'PINNED' }` so the agent can branch on it. Deleting a non-existent file returns `{ deleted: false, reason: 'NOT_FOUND' }` (not an error).",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to delete. Must start with /workspace/.',
      },
    },
    required: ['path'],
  },
  async execute({ path }) {
    assertWithinWorkspace(path);
    if (isPinned(path)) {
      return {
        ok: true,
        summary: `delete_file · ${path} · refused (pinned)`,
        data: { path, deleted: false, reason: 'PINNED' },
      };
    }
    try {
      await getVFS().promises.unlink(path);
      notifyVfsWrite(path, '');
      return {
        ok: true,
        summary: `delete_file · ${path} · deleted`,
        data: { path, deleted: true },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: true,
          summary: `delete_file · ${path} · not found`,
          data: { path, deleted: false, reason: 'NOT_FOUND' },
        };
      }
      throw err;
    }
  },
};
