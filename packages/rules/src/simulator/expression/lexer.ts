/**
 * Item 4.1.2 — Lexer for the transaction-tool expression language.
 *
 * `tokenize(src)` consumes a single-line source string and returns a
 * stream of `Token`s ending in an `eof` marker. The lexer is purely
 * syntactic — no semantic checks (those live in the parser/evaluator).
 *
 * Defensive choices, with rationale:
 *  - Source-length cap is enforced BEFORE the scan begins (cheap reject
 *    for pathological inputs).
 *  - The main loop asserts forward progress every iteration (no
 *    silent infinite loops if a future change forgets to advance).
 *  - Lone `=`, `&`, `|` are explicit unknown-char errors, NOT silently
 *    promoted to their two-char cousins. (Otherwise a typo like `a = b`
 *    would parse as `a == b`.)
 *  - Numbers reject leading zeros (`01` errors, but `0.5` and `0` are
 *    fine). Catches typos; matches JSON's stance.
 *  - Numbers reject anything that doesn't round-trip as
 *    `Number.isSafeInteger` for the integer portion. Firestore counters
 *    care about exact integers.
 *  - Identifiers are strictly ASCII (`[a-zA-Z_][a-zA-Z0-9_]*`); `$café`
 *    errors loudly rather than silently truncating.
 *  - String literals accept both `"…"` and `'…'`. Either delimiter
 *    is valid; the matching delimiter inside the string requires an
 *    escape (`\"` or `\'`); the other quote is a literal character.
 *    Single-quote support was folded in 2026-05-05 after the Item 4.6
 *    forward-deployed probe surfaced 9 lex_errors across 3 prompts
 *    where models naturally reached for single quotes.
 *  - String escapes are restricted to `\"`, `\'`, `\\`, `\n`, `\t` —
 *    anything else after `\` is an error. The escape whitelist is
 *    documented in the design doc; widening it is a deliberate spec
 *    change.
 */

import {
  EXPRESSION_LIMITS,
  ExpressionLexError,
  type Position,
  type Token,
  type TokenKind,
} from './types.js';

const SINGLE_CHAR_TOKENS: Record<string, TokenKind> = {
  '(': 'lparen',
  ')': 'rparen',
  '[': 'lbracket',
  ']': 'rbracket',
  ',': 'comma',
  '.': 'dot',
  '?': 'question',
  ':': 'colon',
  '+': 'plus',
  '-': 'minus',
  '*': 'star',
  '/': 'slash',
  '%': 'percent',
};

const KEYWORDS: Record<string, TokenKind> = {
  true: 'true',
  false: 'false',
  null: 'null',
};

export function tokenize(src: string): Token[] {
  if (src.length > EXPRESSION_LIMITS.maxExpressionLength) {
    throw new ExpressionLexError(
      `expression exceeds ${EXPRESSION_LIMITS.maxExpressionLength}-character cap (got ${src.length})`,
      pos(EXPRESSION_LIMITS.maxExpressionLength),
    );
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const startPos = i;
    const ch = src[i]!;

    // Whitespace — tolerate space, tab, CR, LF. Newlines are unusual in
    // a one-line expression but harmless to tolerate.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }

    // String literal — accepts both `"` and `'` as the delimiter.
    if (ch === '"' || ch === "'") {
      const { token, next } = readString(src, i, ch);
      tokens.push(token);
      i = next;
      // Forward-progress invariant.
      if (i <= startPos) {
        throw new ExpressionLexError('lexer stalled on string', pos(startPos));
      }
      continue;
    }

    // Number literal.
    if (ch >= '0' && ch <= '9') {
      const { token, next } = readNumber(src, i);
      tokens.push(token);
      i = next;
      if (i <= startPos) {
        throw new ExpressionLexError('lexer stalled on number', pos(startPos));
      }
      continue;
    }

    // Identifier or keyword.
    if (isIdentStart(ch)) {
      const { token, next } = readIdentifier(src, i);
      tokens.push(token);
      i = next;
      continue;
    }

    // Reference: `$alias`.
    if (ch === '$') {
      const { token, next } = readPrefixed(src, i, '$', 'reference');
      tokens.push(token);
      i = next;
      continue;
    }

    // Sentinel: `@name`.
    if (ch === '@') {
      const { token, next } = readPrefixed(src, i, '@', 'sentinel');
      tokens.push(token);
      i = next;
      continue;
    }

    // Two-char operators.
    if (ch === '=' && src[i + 1] === '=') {
      tokens.push({ kind: 'eq', pos: pos(i) });
      i += 2;
      continue;
    }
    if (ch === '!' && src[i + 1] === '=') {
      tokens.push({ kind: 'neq', pos: pos(i) });
      i += 2;
      continue;
    }
    if (ch === '<') {
      if (src[i + 1] === '=') {
        tokens.push({ kind: 'lte', pos: pos(i) });
        i += 2;
      } else {
        tokens.push({ kind: 'lt', pos: pos(i) });
        i += 1;
      }
      continue;
    }
    if (ch === '>') {
      if (src[i + 1] === '=') {
        tokens.push({ kind: 'gte', pos: pos(i) });
        i += 2;
      } else {
        tokens.push({ kind: 'gt', pos: pos(i) });
        i += 1;
      }
      continue;
    }
    if (ch === '&') {
      if (src[i + 1] !== '&') {
        throw new ExpressionLexError(
          `unexpected '&' (did you mean '&&'?)`,
          pos(i),
        );
      }
      tokens.push({ kind: 'and', pos: pos(i) });
      i += 2;
      continue;
    }
    if (ch === '|') {
      if (src[i + 1] !== '|') {
        throw new ExpressionLexError(
          `unexpected '|' (did you mean '||'?)`,
          pos(i),
        );
      }
      tokens.push({ kind: 'or', pos: pos(i) });
      i += 2;
      continue;
    }
    if (ch === '!') {
      tokens.push({ kind: 'bang', pos: pos(i) });
      i += 1;
      continue;
    }
    if (ch === '=') {
      throw new ExpressionLexError(
        `unexpected '=' (did you mean '=='?)`,
        pos(i),
      );
    }

    // Single-char punctuators / arithmetic operators.
    const single = SINGLE_CHAR_TOKENS[ch];
    if (single) {
      tokens.push({ kind: single, pos: pos(i) });
      i += 1;
      continue;
    }

    // Unknown character.
    throw new ExpressionLexError(
      `unexpected character ${JSON.stringify(ch)}`,
      pos(i),
    );
  }

  tokens.push({ kind: 'eof', pos: pos(src.length) });
  return tokens;
}

function pos(offset: number): Position {
  return { offset, column: offset + 1 };
}

function isIdentStart(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z')
    || (ch >= 'A' && ch <= 'Z')
    || ch === '_'
  );
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function readIdentifier(src: string, start: number): { token: Token; next: number } {
  let end = start + 1;
  while (end < src.length && isIdentCont(src[end]!)) end += 1;
  const text = src.slice(start, end);
  const keyword = KEYWORDS[text];
  if (keyword) {
    return { token: { kind: keyword, pos: pos(start) }, next: end };
  }
  return { token: { kind: 'identifier', pos: pos(start), value: text }, next: end };
}

function readPrefixed(
  src: string,
  start: number,
  prefix: '$' | '@',
  kind: 'reference' | 'sentinel',
): { token: Token; next: number } {
  // After consuming the prefix, expect an identifier.
  const idStart = start + 1;
  if (idStart >= src.length || !isIdentStart(src[idStart]!)) {
    throw new ExpressionLexError(
      `expected identifier after '${prefix}'`,
      pos(start),
    );
  }
  let end = idStart + 1;
  while (end < src.length && isIdentCont(src[end]!)) end += 1;
  const text = src.slice(idStart, end);
  return { token: { kind, pos: pos(start), value: text }, next: end };
}

function readNumber(src: string, start: number): { token: Token; next: number } {
  let i = start;

  // Integer portion.
  // Leading zero rule: a leading `0` is OK only if followed by `.` or
  // an end-of-number boundary. `01`, `00` are errors.
  const firstDigit = src[i]!;
  i += 1;
  if (firstDigit === '0') {
    if (i < src.length && src[i]! >= '0' && src[i]! <= '9') {
      throw new ExpressionLexError(
        `leading zeros are not allowed in number literals`,
        pos(start),
      );
    }
  } else {
    while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i += 1;
  }

  // Optional fractional portion. The `.` is fractional ONLY if the
  // next char is a digit; if it's an ident-start, leave the `.` for
  // the main loop to lex as postfix-access (e.g. `5.foo` → number,
  // dot, ident). A `.` followed by anything else (whitespace, EOF,
  // another operator) is a malformed `5.` literal — error.
  let hasFraction = false;
  if (i < src.length && src[i] === '.') {
    const after = src[i + 1];
    if (after !== undefined && after >= '0' && after <= '9') {
      hasFraction = true;
      i += 1; // consume `.`
      while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i += 1;
    } else if (after !== undefined && isIdentStart(after)) {
      // Leave the dot for postfix lexing — number ends at `i`.
    } else {
      throw new ExpressionLexError(
        `expected digit after '.' in number literal`,
        pos(i),
      );
    }
  }

  // No scientific notation in v1. If we encounter `e`/`E` here, it'd
  // be the start of an identifier — emit just the number, the next
  // iteration will pick up the identifier and the parser will fail.

  const raw = src.slice(start, i);
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new ExpressionLexError(
      `numeric literal '${raw}' is not finite`,
      pos(start),
    );
  }
  if (!hasFraction && !Number.isSafeInteger(value)) {
    throw new ExpressionLexError(
      `integer literal '${raw}' exceeds safe integer range`,
      pos(start),
    );
  }
  return { token: { kind: 'number', pos: pos(start), value }, next: i };
}

function readString(
  src: string,
  start: number,
  quote: '"' | "'",
): { token: Token; next: number } {
  // Caller guarantees src[start] === quote.
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === quote) {
      // (length already enforced incrementally below)
      return {
        token: { kind: 'string', pos: pos(start), value: out },
        next: i + 1,
      };
    }
    if (ch === '\\') {
      const esc = src[i + 1];
      if (esc === undefined) {
        throw new ExpressionLexError(
          `unterminated escape sequence in string literal`,
          pos(i),
        );
      }
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "'":
          out += "'";
          break;
        case '\\':
          out += '\\';
          break;
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        default:
          throw new ExpressionLexError(
            `invalid escape sequence '\\${esc}' (only \\", \\', \\\\, \\n, \\t are allowed)`,
            pos(i),
          );
      }
      i += 2;
    } else if (ch === '\n' || ch === '\r') {
      throw new ExpressionLexError(
        `unterminated string literal (newline before closing quote)`,
        pos(start),
      );
    } else {
      out += ch;
      i += 1;
    }
    if (out.length > EXPRESSION_LIMITS.maxStringLiteralLength) {
      throw new ExpressionLexError(
        `string literal exceeds ${EXPRESSION_LIMITS.maxStringLiteralLength}-character cap`,
        pos(start),
      );
    }
  }
  throw new ExpressionLexError(
    `unterminated string literal`,
    pos(start),
  );
}
