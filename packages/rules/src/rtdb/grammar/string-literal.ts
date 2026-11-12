/**
 * RTDB rule string literal validation and unescaping.
 *
 * Production's RTDB rules compiler accepts JavaScript-style escape sequences in
 * both single- and double-quoted string literals (including `\'`, `\xHH`, and a
 * raw tab character), while rejecting a raw newline inside a string literal
 * with `"unterminated string literal"` (`r44-deploy-string-and-regex-probes`).
 * Unlike `JSON.parse`, this unescaper never throws `SyntaxError` on `\'`,
 * `\xHH`, or raw control characters.
 */

import { skipRegexLiteral } from '../../grammar/bracket-scan.js';

export const UNTERMINATED_STRING_LITERAL = 'unterminated string literal';

const HEX_2_RE = /^[0-9a-fA-F]{2}$/;
const HEX_4_RE = /^[0-9a-fA-F]{4}$/;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '/': '/',
};

/** Whether a matched string literal token (`"..."` or `'...'`) contains a raw line break. */
export function isUnterminatedRtdbStringLiteral(literal: string): boolean {
  const inner = stripOuterQuotes(literal);
  return inner.includes('\n') || inner.includes('\r');
}

/** Whether `raw` expression text contains a raw line break inside any string literal. */
export function containsRawNewlineInRtdbString(raw: string): boolean {
  let i = 0;
  const n = raw.length;
  let mayStartRegex = true;

  while (i < n) {
    const ch = raw[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n) {
        const c = raw[i]!;
        if (c === '\n' || c === '\r') {
          return true;
        }
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      mayStartRegex = false;
      continue;
    }
    if (ch === '/' && mayStartRegex) {
      i = skipRegexLiteral(raw, i);
      mayStartRegex = false;
      continue;
    }
    mayStartRegex = isRegexPrefixChar(ch);
    i++;
  }

  return false;
}

/** Unescape an RTDB string literal (`"..."` or `'...'`) into its runtime string value. */
export function unescapeRtdbStringLiteral(literal: string): string {
  const body = stripOuterQuotes(literal);
  let out = '';
  let i = 0;
  const n = body.length;

  while (i < n) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    if (i + 1 >= n) {
      out += '\\';
      break;
    }
    const next = body[i + 1]!;
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    if (next === 'x' && i + 3 < n) {
      const hex = body.slice(i + 2, i + 4);
      if (HEX_2_RE.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    if (next === 'u' && i + 5 < n) {
      const hex = body.slice(i + 2, i + 6);
      if (HEX_4_RE.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
    }
    out += next;
    i += 2;
  }

  return out;
}

function stripOuterQuotes(literal: string): string {
  if (literal.length >= 2) {
    const first = literal[0];
    const last = literal[literal.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return literal.slice(1, -1);
    }
  }
  return literal;
}

function isRegexPrefixChar(ch: string): boolean {
  return '(!,&|?:;=[<>+-*%'.includes(ch);
}
