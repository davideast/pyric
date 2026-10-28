/** Realtime Database rules file text: the reader every RTDB rules load path uses. */

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

const STRING_CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeStringControl(char: string): string {
  const named = STRING_CONTROL_ESCAPES[char];
  if (named !== undefined) return named;
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** True when the next non-whitespace character after `index` closes an object or array. */
function closesContainerAfter(text: string, index: number): boolean {
  let next = index + 1;
  while (next < text.length && isJsonWhitespace(text[next])) next++;
  const closer = text[next];
  return closer === '}' || closer === ']';
}

/**
 * Turn Realtime Database rules text into strict JSON text for `JSON.parse`.
 * A rules file Firebase deploys may carry three things strict JSON refuses:
 * line and block comments, a rule expression broken across lines inside its
 * string, and a trailing comma before `}` or `]`. Comments are removed, raw
 * control characters inside a string are escaped (a line break stays a line
 * break in the parsed expression, where it is whitespace), and trailing commas
 * are dropped. String contents are otherwise unchanged, and every other
 * malformation is left for `JSON.parse` to report.
 */
export function toStrictRulesJson(text: string): string {
  const source = stripJsonComments(text);
  let result = '';
  let inString = false;
  let lastSignificant = '';
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (inString) {
      const isEscape = char === '\\';
      if (isEscape) {
        result += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      const isQuote = char === '"';
      if (isQuote) inString = false;
      const isControl = char.charCodeAt(0) < 0x20;
      result += isControl ? escapeStringControl(char) : char;
      i++;
      continue;
    }

    const isQuote = char === '"';
    if (isQuote) inString = true;
    const followsMember = lastSignificant !== '' && lastSignificant !== '{' && lastSignificant !== '[' && lastSignificant !== ',';
    const isTrailingComma = char === ',' && followsMember && closesContainerAfter(source, i);
    if (!isTrailingComma) result += char;
    if (!isTrailingComma && !isJsonWhitespace(char)) lastSignificant = char;
    i++;
  }

  return result;
}
