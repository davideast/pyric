/**
 * `read_file` — fetch a file from the OPFS VFS. Always returns UTF-8
 * text. Paths must live under `/workspace/` to keep the agent from
 * poking at sibling subtrees (`/packages/`, the git index, etc.).
 */
import type { ToolHandler } from '@inbrowser/agent';

import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

export interface ReadFileArgs {
  path: string;
  /** 1-indexed inclusive line range. When present, only this slice is returned. */
  startLine?: number;
  /** 1-indexed inclusive line range. */
  endLine?: number;
  /** Explicit opt-in to return the whole file even when it is large. */
  full?: boolean;
}

export interface ReadFileData {
  path: string;
  content: string;
  bytes: number;
  totalBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated?: boolean;
}

function assertWithinWorkspace(path: string): void {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`) && path !== WORKSPACE_ROOT) {
    throw new Error(`Path must live under ${WORKSPACE_ROOT}/`);
  }
}

export const readFileHandler: ToolHandler<ReadFileArgs, ReadFileData> = {
  name: 'read_file',
  parallelSafe: true, // read-only (0.2.0 parallelDispatch)
  description:
    "Read a file from the playground's OPFS VFS as UTF-8 text. Prefer `search_file` or a line range (`startLine`/`endLine`) before editing large files. Without a range, output is capped unless `full:true` is set. Paths must live under /workspace/.",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to read. Must start with /workspace/.',
      },
      startLine: {
        type: 'number',
        description: 'Optional 1-indexed inclusive start line. Use with endLine for bounded reads.',
      },
      endLine: {
        type: 'number',
        description: 'Optional 1-indexed inclusive end line. Defaults to startLine when omitted.',
      },
      full: {
        type: 'boolean',
        description: 'Set true only when you need the entire file body; large unranged reads are capped by default.',
      },
    },
    required: ['path'],
  },
  async execute({ path, startLine, endLine, full }) {
    assertWithinWorkspace(path);
    const value = await getVFS().promises.readFile(path, 'utf8');
    const fullContent = typeof value === 'string' ? value : new TextDecoder().decode(value);
    const lines = fullContent.split('\n');
    const totalLines = lines.length;
    let from = 1;
    let to = totalLines;
    let content = fullContent;
    let truncated = false;

    if (typeof startLine === 'number' || typeof endLine === 'number') {
      from = clampLine(startLine ?? endLine ?? 1, totalLines);
      to = clampLine(endLine ?? startLine ?? from, totalLines);
      if (to < from) [from, to] = [to, from];
      content = lines.slice(from - 1, to).join('\n');
    } else if (!full && fullContent.length > MAX_DEFAULT_READ_CHARS) {
      content = fullContent.slice(0, MAX_DEFAULT_READ_CHARS);
      truncated = true;
      to = content.split('\n').length;
    }
    return {
      ok: true,
      summary: `read_file · ${path} · lines ${from}-${to}/${totalLines}${truncated ? ' · truncated' : ''}`,
      data: {
        path,
        content,
        bytes: content.length,
        totalBytes: fullContent.length,
        totalLines,
        startLine: from,
        endLine: to,
        ...(truncated ? { truncated: true as const } : {}),
      },
    };
  },
};

const MAX_DEFAULT_READ_CHARS = 12_000;

function clampLine(value: number, totalLines: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(totalLines, Math.floor(value)));
}
