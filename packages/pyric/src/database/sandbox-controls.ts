/** RTDB-specific owner controls for the public `pyric/sandbox/database` seam. */
import type { LocalSandbox } from 'pyric/sandbox';

import { getOrCreateBackend } from './sandbox/backend-for.js';
import type { JsonValue } from './sandbox/data-tree.js';

export type RtdbRulesJson = { rules: Record<string, unknown> };

/** Replace the active RTDB rules. Pass `null` to restore default allow. */
export function setRules(
  sandbox: LocalSandbox,
  rules: RtdbRulesJson | null,
): void {
  getOrCreateBackend(sandbox).setRules(rules);
}

/** Read the currently active rules as detached JSON. */
export function getActiveRules(sandbox: LocalSandbox): RtdbRulesJson | null {
  return getOrCreateBackend(sandbox).getActiveRules();
}

/** Replace RTDB data in bulk without applying security rules. */
export function setData(
  sandbox: LocalSandbox,
  data: Record<string, unknown>,
): void {
  getOrCreateBackend(sandbox).setData(data as Record<string, JsonValue>);
}

/** Snapshot the complete RTDB tree without applying security rules. */
export function snapshotState(sandbox: LocalSandbox): JsonValue {
  return getOrCreateBackend(sandbox).snapshotState();
}

/**
 * Strip JavaScript-style line comments (`//...`) and block comments (`/*...*\/`)
 * from JSON source text without altering string literals. Realtime Database
 * rules files permit comment blocks, requiring pre-processing before evaluation.
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const nextChar = i + 1 < text.length ? text[i + 1] : '';

    if (inSingleLineComment) {
      const isNewline = char === '\n' || char === '\r';
      if (isNewline) {
        inSingleLineComment = false;
        result += char;
      }
      i++;
      continue;
    }

    if (inMultiLineComment) {
      const isEndOfBlock = char === '*' && nextChar === '/';
      if (isEndOfBlock) {
        inMultiLineComment = false;
        i += 2;
      } else {
        const isNewline = char === '\n' || char === '\r';
        if (isNewline) {
          result += char; // Preserve line numbering for accurate diagnostics
        }
        i++;
      }
      continue;
    }

    if (inString) {
      const isEscape = char === '\\';
      if (isEscape) {
        result += char;
        if (nextChar !== '') {
          result += nextChar;
          i++;
        }
        i++;
        continue;
      }
      const isQuote = char === '"';
      if (isQuote) {
        inString = false;
      }
      result += char;
      i++;
      continue;
    }

    const isQuote = char === '"';
    if (isQuote) {
      inString = true;
      result += char;
      i++;
      continue;
    }

    const isLineCommentStart = char === '/' && nextChar === '/';
    if (isLineCommentStart) {
      inSingleLineComment = true;
      i += 2;
      continue;
    }

    const isBlockCommentStart = char === '/' && nextChar === '*';
    if (isBlockCommentStart) {
      inMultiLineComment = true;
      i += 2;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}
