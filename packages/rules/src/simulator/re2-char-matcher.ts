import {
  spellRe2PosixClasses,
  spellRe2PropertyShorthand,
  spellRe2SpaceClasses,
} from '../grammar/re2-pattern.js';

/**
 * RE2's general category names. Every other name RE2 reads in `\p{...}` is a
 * script, including two-letter ones such as `Yi`.
 */
const RE2_GENERAL_CATEGORIES: ReadonlySet<string> = new Set([
  'C', 'Cc', 'Cf', 'Co', 'Cs',
  'L', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu',
  'M', 'Mc', 'Me', 'Mn',
  'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Pe', 'Pf', 'Pi', 'Po', 'Ps',
  'S', 'Sc', 'Sk', 'Sm', 'So',
  'Z', 'Zl', 'Zp', 'Zs',
  'Any',
]);

/**
 * Spell RE2's bell escape `\a` as `\x07` both outside and inside character
 * classes. JavaScript RegExp treats `\a` as literal `'a'` in code-unit mode
 * and rejects it under the `u` flag, whereas RE2 defines `\a` as ASCII bell
 * (0x07). Paired backslashes (`\\a`) remain an escaped backslash plus literal `a`.
 *
 * Expects input already normalized by `normalizeRe2ForJsRegExp` (so `\Q...\E`
 * blocks have been expanded into literal escapes) or a single bracket class
 * (where `\Q` is not a quote operator).
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

/** Compile one RE2 character class or single-character escape into a code-point predicate. */
export function compileCharMatcher(rawPattern: string, ignoreCase: boolean): (ch: string) => boolean {
  const normalized = spellRe2BellEscapes(rawPattern);
  const flags = ignoreCase ? 'iu' : 'u';
  try {
    const spelled = spellRe2UnicodeClasses(spellRe2PosixClasses(normalized, true));
    const re = new RegExp(`^${spellRe2SpaceClasses(spelled, true)}$`, flags);
    return (c) => re.test(c);
  } catch {
    const fallbackFlags = ignoreCase ? 'i' : '';
    const spelled = spellRe2PosixClasses(normalized, false);
    const re = new RegExp(`^${spellRe2SpaceClasses(spelled, false)}$`, fallbackFlags);
    return (c) => re.test(c);
  }
}
