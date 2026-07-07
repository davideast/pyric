/**
 * `edit_file` - targeted text replacements over the OPFS VFS.
 * The final content commits through the same pipeline as `write_file`, so
 * rules/app mirrors and validations stay identical for granular edits.
 */
import type { ToolHandler, ToolResult } from '@inbrowser/agent';

import {
  assertWithinWorkspace,
  commitWorkspaceFile,
  readPriorContent,
  type WriteFileData,
} from './writeFile';

export interface EditFileEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface EditFileArgs {
  path: string;
  edits: EditFileEdit[];
}

export interface EditFileData extends WriteFileData {
  editsApplied: number;
}

export interface EditFileFailureData {
  path: string;
  editsApplied: number;
  failedEdit: number;
  occurrences?: number;
}

export const editFileHandler: ToolHandler<EditFileArgs, EditFileData | EditFileFailureData> = {
  name: 'edit_file',
  description:
    "Apply one or more exact text replacements to a workspace file. Each edit is {oldText,newText,replaceAll?}. Fails without writing if oldText is missing or ambiguous unless replaceAll:true. Commits through the same validation pipeline as write_file, so rules/app edits auto-deploy and auto-validate.",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to edit. Must start with /workspace/.',
      },
      edits: {
        type: 'array',
        description:
          'Sequential exact replacements. Each oldText must match once unless replaceAll is true.',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: 'Exact text to replace.',
            },
            newText: {
              type: 'string',
              description: 'Replacement text.',
            },
            replaceAll: {
              type: 'boolean',
              description:
                'When true, replace every occurrence. Required for intentionally non-unique oldText.',
            },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  async execute({ path, edits }) {
    assertWithinWorkspace(path);
    if (!Array.isArray(edits) || edits.length === 0) {
      return {
        ok: false,
        summary: `edit_file · ${path} · no edits supplied`,
        data: { path, editsApplied: 0, failedEdit: 0 },
      };
    }

    let next = await readPriorContent(path);
    let editsApplied = 0;

    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index];
      const oldText = edit?.oldText;
      const newText = edit?.newText;
      if (typeof oldText !== 'string' || oldText.length === 0) {
        return failed(path, editsApplied, index, 'empty oldText');
      }
      if (typeof newText !== 'string') {
        return failed(path, editsApplied, index, 'newText must be a string');
      }
      const occurrences = countOccurrences(next, oldText);
      if (occurrences === 0) {
        return failed(path, editsApplied, index, 'oldText not found', occurrences);
      }
      if (occurrences > 1 && edit.replaceAll !== true) {
        return failed(
          path,
          editsApplied,
          index,
          `oldText is ambiguous (${occurrences} matches); set replaceAll:true to replace all`,
          occurrences,
        );
      }

      if (edit.replaceAll === true) {
        next = next.split(oldText).join(newText);
        editsApplied += occurrences;
      } else {
        next = next.replace(oldText, newText);
        editsApplied += 1;
      }
    }

    const result = await commitWorkspaceFile(path, next, { toolName: 'edit_file' });
    return attachEditStats(result, editsApplied);
  },
};

function failed(
  path: string,
  editsApplied: number,
  failedEdit: number,
  reason: string,
  occurrences?: number,
): ToolResult<EditFileFailureData> {
  return {
    ok: false,
    summary: `edit_file · ${path} · edit ${failedEdit + 1} failed: ${reason}`,
    data: {
      path,
      editsApplied,
      failedEdit,
      ...(occurrences !== undefined ? { occurrences } : {}),
    },
  };
}

function attachEditStats(
  result: ToolResult<WriteFileData>,
  editsApplied: number,
): ToolResult<EditFileData | EditFileFailureData> {
  if (!result.data) return result as ToolResult<EditFileData | EditFileFailureData>;
  return {
    ...result,
    data: {
      ...result.data,
      editsApplied,
    },
  };
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}
