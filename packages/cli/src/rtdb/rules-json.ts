import type { RtdbRulesDocument } from 'pyric/rules/internal/rtdb';

export interface RtdbRulesJson {
  rules: Record<string, unknown>;
}

export function isRtdbRulesJson(value: unknown): value is RtdbRulesJson {
  return isRtdbRulesObject(value) && isRtdbRulesObject(value.rules);
}

export function parseRtdbRulesJson(
  value: unknown,
  onInvalid: () => Error,
): RtdbRulesJson {
  if (!isRtdbRulesJson(value)) throw onInvalid();
  return value;
}

export function isRtdbRulesDocument(value: unknown): value is RtdbRulesDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

function isRtdbRulesObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip JavaScript-style line comments (`//...`) and block comments (`/*...*\/`)
 * from JSON source text without altering string literals. Firebase Realtime
 * Database security rules files (`database.rules.json`) permit comment blocks,
 * requiring pre-processing before evaluation with standard JSON parsers.
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

/**
 * Parse a JSON string that may contain line or block comments into a validated
 * Realtime Database rules document structure.
 */
export function parseRtdbRulesText(
  text: string,
  onInvalid: (error: Error) => Error,
): RtdbRulesJson {
  const clean = stripJsonComments(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw onInvalid(new Error(`Failed to parse rules JSON: ${detail}`));
  }
  return parseRtdbRulesJson(parsed, () => onInvalid(new Error('Document must contain a top-level "rules" object.')));
}
