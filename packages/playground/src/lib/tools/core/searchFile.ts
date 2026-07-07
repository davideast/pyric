/**
 * `search_file` - compact literal search within one workspace file.
 * Returns line-numbered snippets so agents can locate the small range they
 * need before calling ranged `read_file` or `edit_file`.
 */
import type { ToolHandler } from '@inbrowser/agent';

import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

export interface SearchFileArgs {
  path: string;
  query: string;
  contextLines?: number;
  maxMatches?: number;
}

export interface SearchFileLine {
  line: number;
  text: string;
}

export interface SearchFileMatch {
  line: number;
  text: string;
  before: SearchFileLine[];
  after: SearchFileLine[];
}

export interface SearchFileData {
  path: string;
  query: string;
  count: number;
  totalMatches: number;
  matches: SearchFileMatch[];
  truncated?: boolean;
}

function assertWithinWorkspace(path: string): void {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`Path must live under ${WORKSPACE_ROOT}/`);
  }
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_MATCHES = 20;
const MAX_CONTEXT_LINES = 10;
const MAX_MATCHES = 100;

export const searchFileHandler: ToolHandler<SearchFileArgs, SearchFileData> = {
  name: 'search_file',
  parallelSafe: true,
  description:
    "Search one workspace file with a case-insensitive literal query and return compact line-numbered snippets. Use this before reading or editing large files. Paths must live under /workspace/.",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to search. Must start with /workspace/.',
      },
      query: {
        type: 'string',
        description: 'Literal text to search for, case-insensitive.',
      },
      contextLines: {
        type: 'number',
        description: 'Lines before and after each match. Defaults to 3, capped at 10.',
      },
      maxMatches: {
        type: 'number',
        description: 'Maximum matches returned. Defaults to 20, capped at 100.',
      },
    },
    required: ['path', 'query'],
  },
  async execute({ path, query, contextLines, maxMatches }) {
    assertWithinWorkspace(path);
    const needle = String(query ?? '');
    if (needle.length === 0) {
      return {
        ok: false,
        summary: `search_file · ${path} · empty query`,
        data: { path, query: needle, count: 0, totalMatches: 0, matches: [] },
      };
    }

    const raw = await getVFS().promises.readFile(path, 'utf8');
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const lines = content.split('\n');
    const context = clampInt(contextLines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
    const limit = clampInt(maxMatches, DEFAULT_MAX_MATCHES, 1, MAX_MATCHES);
    const lowerNeedle = needle.toLowerCase();
    const matches: SearchFileMatch[] = [];
    let totalMatches = 0;

    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(lowerNeedle)) return;
      totalMatches += 1;
      if (matches.length >= limit) return;
      const beforeStart = Math.max(0, index - context);
      const afterEnd = Math.min(lines.length - 1, index + context);
      matches.push({
        line: index + 1,
        text: line,
        before: rangeLines(lines, beforeStart, index - 1),
        after: rangeLines(lines, index + 1, afterEnd),
      });
    });

    const truncated = totalMatches > matches.length;
    return {
      ok: true,
      summary: `search_file · ${path} · ${totalMatches} match${totalMatches === 1 ? '' : 'es'}${truncated ? ` · showing ${matches.length}` : ''}`,
      data: {
        path,
        query: needle,
        count: matches.length,
        totalMatches,
        matches,
        ...(truncated ? { truncated: true as const } : {}),
      },
    };
  },
};

function rangeLines(lines: string[], from: number, to: number): SearchFileLine[] {
  if (to < from) return [];
  const out: SearchFileLine[] = [];
  for (let i = from; i <= to; i += 1) {
    out.push({ line: i + 1, text: lines[i] ?? '' });
  }
  return out;
}

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
