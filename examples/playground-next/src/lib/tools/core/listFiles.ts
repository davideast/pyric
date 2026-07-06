/**
 * `list_files` — enumerate every file under a directory in the
 * OPFS VFS. Default root is `/workspace/`. Used by the agent to
 * orient itself before editing — "what files exist, where do I
 * need to add a new one".
 */
import type { ToolHandler } from '@inbrowser/agent';

import { listAllFiles } from '~/lib/files/file-tree';
import { WORKSPACE_ROOT } from '~/lib/store/files';

export interface ListFilesArgs {
  path?: string;
}

export interface ListFilesData {
  root: string;
  files: string[];
  count: number;
}

export const listFilesHandler: ToolHandler<ListFilesArgs, ListFilesData> = {
  name: 'list_files',
  parallelSafe: true, // read-only (0.2.0 parallelDispatch)
  description:
    "List every file in the playground's OPFS VFS under a directory. Default root is /workspace/. Use this before write_file to check whether the file already exists or to discover the existing module structure.",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: `Absolute directory to walk. Default ${WORKSPACE_ROOT}.`,
      },
    },
  },
  async execute({ path }) {
    const root = path ?? WORKSPACE_ROOT;
    if (!root.startsWith(WORKSPACE_ROOT)) {
      throw new Error(`Path must live under ${WORKSPACE_ROOT}`);
    }
    const files = await listAllFiles(root);
    return {
      ok: true,
      summary: `list_files · ${root} · ${files.length} file${files.length === 1 ? '' : 's'}`,
      data: { root, files, count: files.length },
    };
  },
};
