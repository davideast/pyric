import { RE2_POSIX_CLASSES } from './re2-pattern.js';

/**
 * RE2's general category names. Every other name RE2 reads in `\p{...}` is a
 * Unicode script name, including two-letter ones such as `Yi`.
 */
export const RE2_GENERAL_CATEGORIES: ReadonlySet<string> = new Set([
  'C', 'Cc', 'Cf', 'Co', 'Cs',
  'L', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu',
  'M', 'Mc', 'Me', 'Mn',
  'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Pe', 'Pf', 'Pi', 'Po', 'Ps',
  'S', 'Sc', 'Sk', 'Sm', 'So',
  'Z', 'Zl', 'Zp', 'Zs',
  'Any',
]);

/** Single-letter Unicode category shorthands RE2 accepts in `\pX` / `\PX`. */
const RE2_SHORTHAND_CATEGORIES: ReadonlySet<string> = new Set([
  'C', 'L', 'M', 'N', 'P', 'S', 'Z',
]);

/** Single-character escapes RE2 accepts both outside and inside `[...]`. */
const RE2_COMMON_ESCAPES: ReadonlySet<string> = new Set([
  'a', 'f', 'n', 'r', 't', 'v',
  'd', 'D', 's', 'S', 'w', 'W',
]);

/** Boundary assertions RE2 accepts only outside `[...]`. */
const RE2_ASSERTION_ESCAPES: ReadonlySet<string> = new Set([
  'A', 'z', 'b', 'B',
]);

const SCRIPT_VALIDITY_CACHE = new Map<string, boolean>();

function isAsciiAlnum(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isOctalDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '7';
}

function isValidRe2PropertyName(name: string): boolean {
  if (RE2_GENERAL_CATEGORIES.has(name)) return true;
  const cached = SCRIPT_VALIDITY_CACHE.get(name);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new RegExp(`^\\p{Script=${name}}$`, 'u');
    valid = true;
  } catch {
    valid = false;
  }
  SCRIPT_VALIDITY_CACHE.set(name, valid);
  return valid;
}

/**
 * Scan `pattern` for escape sequences and POSIX / Unicode classes that RE2's
 * parser rejects (such as `\Z`, `\G`, `\R`, `\X`, `\h`, `\e`, `\cA`, `\k<x>`,
 * `[[:foo:]]`, `\p{Foo}`, `\pX`, `\C`, and lone `\1`..`\7` inside `[...]`),
 * returning a diagnostic reason or `null` when every escape and class is valid.
 */
export function findInvalidRe2EscapeOrClass(pattern: string): string | null {
  let i = 0;
  let inClass = false;
  let classStart = false;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const esc = pattern[i + 1];
      if (esc === undefined) return 'Trailing backslash';

      if (!inClass && esc === 'Q') {
        const close = pattern.indexOf('\\E', i + 2);
        i = close === -1 ? pattern.length : close + 2;
        continue;
      }
      if (esc === 'E') {
        return 'Invalid escape sequence: \\E';
      }
      if (!isAsciiAlnum(esc)) {
        const cp = pattern.codePointAt(i + 1)!;
        i += 1 + (cp > 0xffff ? 2 : 1);
        classStart = false;
        continue;
      }
      if (!inClass && RE2_ASSERTION_ESCAPES.has(esc)) {
        i += 2;
        continue;
      }
      if (RE2_COMMON_ESCAPES.has(esc)) {
        i += 2;
        classStart = false;
        continue;
      }
      if (esc === 'x') {
        if (pattern[i + 2] === '{') {
          const close = pattern.indexOf('}', i + 3);
          if (close === -1) return 'Unclosed hex escape';
          const hex = pattern.slice(i + 3, close);
          if (!/^[0-9A-Fa-f]{1,8}$/.test(hex)) return 'Invalid hex escape';
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) return 'Hex escape out of Unicode range';
          i = close + 1;
          classStart = false;
          continue;
        }
        if (!/^[0-9A-Fa-f]{2}$/.test(pattern.slice(i + 2, i + 4))) {
          return 'Invalid hex escape';
        }
        i += 4;
        classStart = false;
        continue;
      }
      if (esc === '0') {
        let len = 2;
        if (isOctalDigit(pattern[i + 2])) {
          len = 3;
          if (isOctalDigit(pattern[i + 3])) len = 4;
        }
        i += len;
        classStart = false;
        continue;
      }
      if (esc >= '1' && esc <= '7') {
        if (!isOctalDigit(pattern[i + 2])) {
          return `Invalid escape sequence: \\${esc}`;
        }
        let len = 3;
        if (esc <= '3' && isOctalDigit(pattern[i + 3])) {
          len = 4;
        }
        i += len;
        classStart = false;
        continue;
      }
      if (esc === 'p' || esc === 'P') {
        if (pattern[i + 2] === '{') {
          const close = pattern.indexOf('}', i + 3);
          if (close === -1) return 'Unclosed Unicode property class';
          const rawInner = pattern.slice(i + 3, close);
          const name = rawInner.startsWith('^') ? rawInner.slice(1) : rawInner;
          if (!/^[A-Za-z_]+$/.test(name) || !isValidRe2PropertyName(name)) {
            return `Invalid Unicode property class: ${pattern.slice(i, close + 1)}`;
          }
          i = close + 1;
          classStart = false;
          continue;
        }
        const short = pattern[i + 2];
        if (short === undefined || !RE2_SHORTHAND_CATEGORIES.has(short)) {
          return `Invalid Unicode property class: \\${esc}${short ?? ''}`;
        }
        i += 3;
        classStart = false;
        continue;
      }
      return `Invalid escape sequence: \\${esc}`;
    }

    if (inClass) {
      if (ch === '[' && pattern[i + 1] === ':') {
        const posixAttempt = /^\[:(\^?)([^:\]]*):\]/.exec(pattern.slice(i));
        if (posixAttempt !== null) {
          const name = posixAttempt[2]!;
          if (!Object.hasOwn(RE2_POSIX_CLASSES, name)) {
            return `Invalid POSIX character class: ${posixAttempt[0]}`;
          }
          i += posixAttempt[0].length;
          classStart = false;
          continue;
        }
      }
      if (ch === ']' && !classStart) {
        inClass = false;
      }
      classStart = false;
      i++;
      continue;
    }

    if (ch === '[') {
      inClass = true;
      i++;
      if (pattern[i] === '^') i++;
      classStart = true;
      continue;
    }

    i++;
  }

  if (inClass) return 'Unclosed character class';
  return null;
}
