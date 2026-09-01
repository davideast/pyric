/** RTDB-specific owner controls for the public `pyric/sandbox/database` seam. */
import type { LocalSandbox } from 'pyric/sandbox';

import { getOrCreateBackend } from './sandbox/backend-for.js';
import type { RtdbBackend } from './sandbox/backend.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { TARGET_SYMBOL, targetOf } from './routing.js';

export type RtdbRulesJson = { rules: Record<string, unknown> };

/** Target accepting either a LocalSandbox root or a branded Database handle. */
export type RtdbTarget = LocalSandbox | { [TARGET_SYMBOL]: unknown };

function backendOf(target: RtdbTarget): RtdbBackend {
  if (target && typeof target === 'object' && TARGET_SYMBOL in target) {
    return targetOf(target).backend;
  }
  return getOrCreateBackend(target as LocalSandbox);
}

/** Set default access policy when no rules are loaded ('allow' or 'deny'). Internal test/dev harness control. */
export function setDefaultPolicy(
  target: RtdbTarget,
  policy: 'allow' | 'deny',
): void {
  backendOf(target).setDefaultPolicy(policy);
}

/** Replace the active RTDB rules. Pass `null` to restore default deny. */
export function setRules(
  target: RtdbTarget,
  rules: RtdbRulesJson | null,
): void {
  backendOf(target).setRules(rules);
}

/** Read the currently active rules as detached JSON. */
export function getActiveRules(target: RtdbTarget): RtdbRulesJson | null {
  return backendOf(target).getActiveRules();
}

/** Replace RTDB data in bulk without applying security rules. */
export function setData(
  target: RtdbTarget,
  data: Record<string, unknown>,
): void {
  backendOf(target).setData(data as Record<string, JsonValue>);
}

/** Snapshot the complete RTDB tree without applying security rules. */
export function snapshotState(target: RtdbTarget): JsonValue {
  return backendOf(target).snapshotState();
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
