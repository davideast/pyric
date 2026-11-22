import { RE2_GENERAL_CATEGORIES } from '../grammar/re2-escape-validation.js';
import {
  RE2_POSIX_CLASSES,
  spellRe2PropertyShorthand,
} from '../grammar/re2-pattern.js';
import { re2CaseFoldOrbit } from './re2-case-fold.js';

/**
 * Spell RE2's bell escape `\a` as `\x07` both outside and inside character
 * classes. JavaScript RegExp treats `\a` as literal `'a'` in code-unit mode
 * and rejects it under the `u` flag, whereas RE2 defines `\a` as ASCII bell
 * (0x07). Paired backslashes (`\\a`) remain an escaped backslash plus literal `a`.
 */
export function spellRe2BellEscapes(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      if (source[i + 1] === 'a') {
        out += '\\x07';
      } else {
        out += source.slice(i, i + 2);
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Spell RE2's Unicode classes in the form a JavaScript `u` RegExp reads:
 * `\pL` as `\p{L}`, a script such as `\p{Cyrillic}` as `\p{Script=Cyrillic}`,
 * and the negated `\p{^Greek}` as `\P{Script=Greek}`.
 */
export function spellRe2UnicodeClasses(source: string): string {
  return spellRe2PropertyShorthand(source).replace(
    /(\\\\)|\\([pP])\{(\^?)([A-Za-z_]+)\}/g,
    (whole: string, escapedBackslash: string | undefined, escape: string, caret: string, name: string) => {
      if (escapedBackslash !== undefined) return whole;
      const negated = (escape === 'P') !== (caret === '^');
      const property = RE2_GENERAL_CATEGORIES.has(name) ? name : `Script=${name}`;
      const letter = negated ? 'P' : 'p';
      return `\\${letter}{${property}}`;
    },
  );
}

const UNICODE_PROP_CACHE = new Map<string, RegExp>();

function positiveUnicodePropertyRegex(name: string): RegExp {
  const property = RE2_GENERAL_CATEGORIES.has(name) ? name : `Script=${name}`;
  const cached = UNICODE_PROP_CACHE.get(property);
  if (cached !== undefined) return cached;
  const re = new RegExp(`^\\p{${property}}$`, 'u');
  UNICODE_PROP_CACHE.set(property, re);
  return re;
}

function cpInRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function isAsciiDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

function isRe2Space(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d || cp === 0x20;
}

function isAsciiWord(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    cp === 0x5f
  );
}

function buildRangePredicate(lo: number, hi: number, ignoreCase: boolean): (ch: string) => boolean {
  if (!ignoreCase) {
    return (ch) => {
      const cp = ch.codePointAt(0);
      return cp !== undefined && cp >= lo && cp <= hi;
    };
  }
  return (ch) => {
    for (const peer of re2CaseFoldOrbit(ch)) {
      const cp = peer.codePointAt(0);
      if (cp !== undefined && cp >= lo && cp <= hi) return true;
    }
    return false;
  };
}

function buildPosixPredicate(
  name: string,
  negated: boolean,
  ignoreCase: boolean,
): (ch: string) => boolean {
  const ranges = RE2_POSIX_CLASSES[name]!;
  return (ch) => {
    let matched = false;
    if (!ignoreCase) {
      const cp = ch.codePointAt(0);
      matched = cp !== undefined && cpInRanges(cp, ranges);
    } else {
      for (const peer of re2CaseFoldOrbit(ch)) {
        const cp = peer.codePointAt(0);
        if (cp !== undefined && cpInRanges(cp, ranges)) {
          matched = true;
          break;
        }
      }
    }
    return negated ? !matched : matched;
  };
}

function buildUnicodePropertyPredicate(
  name: string,
  negated: boolean,
  ignoreCase: boolean,
): (ch: string) => boolean {
  const posRe = positiveUnicodePropertyRegex(name);
  return (ch) => {
    let matched = false;
    if (!ignoreCase) {
      matched = posRe.test(ch);
    } else {
      for (const peer of re2CaseFoldOrbit(ch)) {
        if (posRe.test(peer)) {
          matched = true;
          break;
        }
      }
    }
    return negated ? !matched : matched;
  };
}

function buildPerlClassPredicate(esc: string): (ch: string) => boolean {
  switch (esc) {
    case 'd':
      return (ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && isAsciiDigit(cp);
      };
    case 'D':
      return (ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && !isAsciiDigit(cp);
      };
    case 's':
      return (ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && isRe2Space(cp);
      };
    case 'S':
      return (ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && !isRe2Space(cp);
      };
    case 'w':
      return (ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && isAsciiWord(cp);
      };
    default:
      return (ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && !isAsciiWord(cp);
      };
  }
}

type ParsedAtom =
  | { kind: 'pred'; test: (ch: string) => boolean; next: number }
  | { kind: 'char'; cp: number; next: number };

function readAtomAt(source: string, pos: number, ignoreCase: boolean): ParsedAtom {
  if (source[pos] === '[' && source[pos + 1] === ':') {
    const posix = /^\[:(\^?)([a-z]+):\]/.exec(source.slice(pos, pos + 12));
    if (posix !== null && Object.hasOwn(RE2_POSIX_CLASSES, posix[2]!)) {
      return {
        kind: 'pred',
        test: buildPosixPredicate(posix[2]!, posix[1] === '^', ignoreCase),
        next: pos + posix[0].length,
      };
    }
  }
  if (source[pos] === '\\') {
    const esc = source[pos + 1]!;
    if (esc === 'd' || esc === 'D' || esc === 's' || esc === 'S' || esc === 'w' || esc === 'W') {
      return { kind: 'pred', test: buildPerlClassPredicate(esc), next: pos + 2 };
    }
    if (esc === 'p' || esc === 'P') {
      if (source[pos + 2] === '{') {
        const close = source.indexOf('}', pos + 3);
        const rawInner = source.slice(pos + 3, close);
        const hasCaret = rawInner.startsWith('^');
        const name = hasCaret ? rawInner.slice(1) : rawInner;
        const negated = (esc === 'P') !== hasCaret;
        return {
          kind: 'pred',
          test: buildUnicodePropertyPredicate(name, negated, ignoreCase),
          next: close + 1,
        };
      }
      const short = source[pos + 2]!;
      return {
        kind: 'pred',
        test: buildUnicodePropertyPredicate(short, esc === 'P', ignoreCase),
        next: pos + 3,
      };
    }
    if (esc === 'a') return { kind: 'char', cp: 0x07, next: pos + 2 };
    if (esc === 'f') return { kind: 'char', cp: 0x0c, next: pos + 2 };
    if (esc === 'n') return { kind: 'char', cp: 0x0a, next: pos + 2 };
    if (esc === 'r') return { kind: 'char', cp: 0x0d, next: pos + 2 };
    if (esc === 't') return { kind: 'char', cp: 0x09, next: pos + 2 };
    if (esc === 'v') return { kind: 'char', cp: 0x0b, next: pos + 2 };
    if (esc === 'x') {
      if (source[pos + 2] === '{') {
        const close = source.indexOf('}', pos + 3);
        const cp = parseInt(source.slice(pos + 3, close), 16);
        return { kind: 'char', cp, next: close + 1 };
      }
      const cp = parseInt(source.slice(pos + 2, pos + 4), 16);
      return { kind: 'char', cp, next: pos + 4 };
    }
    if (esc >= '0' && esc <= '7') {
      let len = 1;
      if (source[pos + 2] !== undefined && source[pos + 2]! >= '0' && source[pos + 2]! <= '7') {
        len = 2;
        if (
          esc <= '3' &&
          source[pos + 3] !== undefined &&
          source[pos + 3]! >= '0' &&
          source[pos + 3]! <= '7'
        ) {
          len = 3;
        }
      }
      const cp = parseInt(source.slice(pos + 1, pos + 1 + len), 8);
      return { kind: 'char', cp, next: pos + 1 + len };
    }
    const cp = source.codePointAt(pos + 1)!;
    return { kind: 'char', cp, next: pos + 1 + (cp > 0xffff ? 2 : 1) };
  }
  const cp = source.codePointAt(pos)!;
  return { kind: 'char', cp, next: pos + (cp > 0xffff ? 2 : 1) };
}

/** Compile one RE2 character class or single-character escape into a code-point predicate. */
export function compileCharMatcher(rawPattern: string, ignoreCase: boolean): (ch: string) => boolean {
  if (rawPattern.startsWith('[') && rawPattern.endsWith(']')) {
    const end = rawPattern.length - 1;
    let i = 1;
    let outerNegated = false;
    if (rawPattern[i] === '^') {
      outerNegated = true;
      i++;
    }
    const predicates: Array<(ch: string) => boolean> = [];
    while (i < end) {
      const first = readAtomAt(rawPattern, i, ignoreCase);
      i = first.next;
      if (first.kind === 'pred') {
        predicates.push(first.test);
        continue;
      }
      if (i < end && rawPattern[i] === '-' && i + 1 < end) {
        i++;
        const second = readAtomAt(rawPattern, i, ignoreCase);
        i = second.next;
        if (second.kind === 'char') {
          predicates.push(buildRangePredicate(first.cp, second.cp, ignoreCase));
          continue;
        }
      }
      predicates.push(buildRangePredicate(first.cp, first.cp, ignoreCase));
    }
    return (ch) => {
      for (const pred of predicates) {
        if (pred(ch)) return !outerNegated;
      }
      return outerNegated;
    };
  }

  const atom = readAtomAt(rawPattern, 0, ignoreCase);
  if (atom.kind === 'pred') return atom.test;
  return buildRangePredicate(atom.cp, atom.cp, ignoreCase);
}
