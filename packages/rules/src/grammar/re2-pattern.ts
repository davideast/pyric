const JS_CLASS_METACHAR = /^[\\\^\-\[\]]$/;
const JS_SYNTAX_CHAR = /^[\^$\\.*+?()[\]{}|]$/;

/**
 * Normalize RE2-specific syntax (`(?i)`, `(?i:...)`, `(?P<name>...)`, `\A`,
 * `\z`, `\x{...}`, and leading `]` inside `[...]`) into a form JS `new RegExp`
 * can syntax-check without rejecting valid RE2 patterns.
 */
export function normalizeRe2ForJsRegExp(source: string): string {
  let out = '';
  let i = 0;
  let inClass = false;
  let classStart = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) {
        out += '\\';
        break;
      }
      if (!inClass && next === 'Q') {
        const close = source.indexOf('\\E', i + 2);
        const end = close === -1 ? source.length : close;
        for (const literal of source.slice(i + 2, end)) {
          out += JS_SYNTAX_CHAR.test(literal) ? `\\${literal}` : literal;
        }
        i = close === -1 ? source.length : close + 2;
        continue;
      }
      if (!inClass && next === 'A') {
        out += '^';
        i += 2;
        continue;
      }
      if (!inClass && next === 'z') {
        out += '$';
        i += 2;
        continue;
      }
      if ((next === 'x' || next === 'u') && source[i + 2] === '{') {
        const close = source.indexOf('}', i + 3);
        if (close !== -1) {
          const hex = source.slice(i + 3, close);
          if (/^[0-9A-Fa-f]+$/.test(hex)) {
            const decoded = String.fromCodePoint(parseInt(hex, 16));
            const needsEscape = inClass ? JS_CLASS_METACHAR.test(decoded) : JS_SYNTAX_CHAR.test(decoded);
            out += needsEscape ? `\\${decoded}` : decoded;
            i = close + 1;
            classStart = false;
            continue;
          }
        }
      }
      if (/^[0-3][0-7]{2}/.test(source.slice(i + 1))) {
        const decoded = String.fromCodePoint(parseInt(source.slice(i + 1, i + 4), 8));
        const needsEscape = inClass ? JS_CLASS_METACHAR.test(decoded) : JS_SYNTAX_CHAR.test(decoded);
        out += needsEscape ? `\\${decoded}` : decoded;
        i += 4;
        classStart = false;
        continue;
      }
      out += source.slice(i, i + 2);
      i += 2;
      classStart = false;
      continue;
    }
    if (inClass) {
      const posix = re2PosixClassAt(source, i);
      if (posix !== null) {
        out += source.slice(i, i + posix.length);
        i += posix.length;
        classStart = false;
        continue;
      }
      if (ch === ']' && classStart) {
        out += '\\]';
        i++;
        classStart = false;
        continue;
      }
      if (ch === ']') {
        inClass = false;
      }
      out += ch;
      i++;
      classStart = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += '[';
      i++;
      if (source[i] === '^') {
        out += '^';
        i++;
      }
      classStart = true;
      continue;
    }
    if (ch === '(' && source[i + 1] === '?') {
      const rest = source.slice(i + 2);
      const named = /^P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
      if (named) {
        out += `(?<${named[1]}>`;
        i += 2 + named[0].length;
        continue;
      }
      const scopedFlags = /^([imsU-]+):/.exec(rest);
      if (scopedFlags) {
        out += '(?:';
        i += 2 + scopedFlags[0].length;
        continue;
      }
      const inlineFlags = /^([imsU-]+)\)/.exec(rest);
      if (inlineFlags) {
        const afterClose = source[i + 2 + inlineFlags[0].length];
        if (afterClose === '*' || afterClose === '+' || afterClose === '?' || afterClose === '{') {
          throw new Error('Nothing to repeat after inline flag group');
        }
        out += '(?:)';
        i += 2 + inlineFlags[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** RE2's `\s`: `[\t\n\f\r ]`. No vertical tab, NBSP or other Unicode space. */
const RE2_SPACE_MEMBERS = '\\t\\n\\f\\r ';

/** Everything outside `\s`, as class members, for a `u` or a code-unit RegExp. */
function re2NonSpaceMembers(unicode: boolean): string {
  const top = unicode ? '\\u{10FFFF}' : '\\uFFFF';
  return `\\x00-\\x08\\x0B\\x0E-\\x1F!-${top}`;
}

/**
 * Spell RE2's `\s` and `\S` out as ASCII classes in a JS RegExp source, so a
 * JS engine does not read them as Unicode white space. Production compiles
 * rules patterns as RE2, where `\s` is `[\t\n\f\r ]`: the 2026-10-27 capture
 * `re2-pattern-semantics` shows NBSP, U+2003 and vertical tab are not `\s`.
 *
 * `source` is already normalized by `normalizeRe2ForJsRegExp`, so a class
 * opens at an unescaped `[` and closes at the next unescaped `]`. `unicode`
 * says whether the RegExp is compiled with the `u` flag.
 */
export function spellRe2SpaceClasses(source: string, unicode: boolean): string {
  let out = '';
  let inClass = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\' && i + 1 < source.length) {
      out += re2SpaceEscape(source[i + 1]!, inClass, unicode) ?? source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const posix = inClass ? re2PosixClassAt(source, i) : null;
    if (posix !== null) {
      out += source.slice(i, i + posix.length);
      i += posix.length;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    out += ch;
    i++;
  }
  return out;
}

function re2SpaceEscape(escape: string, inClass: boolean, unicode: boolean): string | undefined {
  if (escape === 's') return inClass ? RE2_SPACE_MEMBERS : `[${RE2_SPACE_MEMBERS}]`;
  if (escape !== 'S') return undefined;
  if (inClass) return re2NonSpaceMembers(unicode);
  return `[^${RE2_SPACE_MEMBERS}]`;
}

/**
 * Scan an RE2 pattern for the constructs JavaScript accepts and RE2 rejects
 * (a backreference, a lookaround), and collect its inline flags (`(?i)`,
 * `(?m)`, `(?s)`, and their scoped forms) as JavaScript RegExp flags.
 * `normalizeRe2ForJsRegExp` drops an inline flag group, so a caller that
 * compiles the pattern as one RegExp passes these flags to keep `(?i)`. A
 * flag applies to the whole RegExp, which matches RE2 for a leading flag
 * group, the form rules use.
 */
export function scanRe2Pattern(pattern: string): {
  unsupported: 'backreference' | 'lookaround' | null;
  inlineFlags: string;
} {
  let inClass = false;
  let classStart = false;
  let flagI = false;
  let flagM = false;
  let flagS = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (!inClass && next === 'Q') {
        const close = pattern.indexOf('\\E', i + 2);
        i = close === -1 ? pattern.length : close + 2;
        continue;
      }
      if (/^[0-3][0-7]{2}/.test(pattern.slice(i + 1))) {
        i += 4;
        classStart = false;
        continue;
      }
      if (!inClass && next !== undefined && next >= '1' && next <= '9') {
        return { unsupported: 'backreference', inlineFlags: '' };
      }
      i += 2;
      classStart = false;
      continue;
    }
    if (inClass) {
      const posix = re2PosixClassAt(pattern, i);
      if (posix !== null) {
        i += posix.length;
        classStart = false;
        continue;
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
    if (ch === '(' && pattern[i + 1] === '?') {
      const rest = pattern.slice(i + 2);
      if (rest.startsWith('=') || rest.startsWith('!') || rest.startsWith('<=') || rest.startsWith('<!')) {
        return { unsupported: 'lookaround', inlineFlags: '' };
      }
      const flagMatch = /^([imsU-]+)[):]/.exec(rest);
      if (flagMatch) {
        let clearing = false;
        for (const f of flagMatch[1]!) {
          if (f === '-') clearing = true;
          else if (f === 'i') flagI = !clearing;
          else if (f === 'm') flagM = !clearing;
          else if (f === 's') flagS = !clearing;
        }
      }
    }
    i++;
  }
  const inlineFlags = `${flagI ? 'i' : ''}${flagM ? 'm' : ''}${flagS ? 's' : ''}`;
  return { unsupported: null, inlineFlags };
}

/**
 * Spell RE2's one-letter Unicode classes (`\pL`, `\PN`) in the braced form a
 * JavaScript `u` RegExp reads (`\p{L}`, `\P{N}`). Without the braces a JS
 * engine reads `\pL` as the letters `pL` or rejects it under the `u` flag.
 * The 2026-10-27 capture `re2-pattern-semantics` shows production reads
 * `'a'.matches('\\pL')` as a letter and `'pL'.matches('\\pL')` as no match.
 */
export function spellRe2PropertyShorthand(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch !== '\\' || i + 1 >= source.length) {
      out += ch;
      i++;
      continue;
    }
    const escape = source[i + 1]!;
    const name = source[i + 2];
    const isShorthand = (escape === 'p' || escape === 'P') && name !== undefined && /[A-Za-z]/.test(name);
    out += isShorthand ? `\\${escape}{${name}}` : source.slice(i, i + 2);
    i += isShorthand ? 3 : 2;
  }
  return out;
}

/**
 * RE2's POSIX classes, each as code point ranges. They are ASCII only, as
 * RE2's are: `[[:alpha:]]` is `[A-Za-z]`.
 */
const RE2_POSIX_CLASSES: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>> = {
  alnum: [[0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a]],
  alpha: [[0x41, 0x5a], [0x61, 0x7a]],
  ascii: [[0x00, 0x7f]],
  blank: [[0x09, 0x09], [0x20, 0x20]],
  cntrl: [[0x00, 0x1f], [0x7f, 0x7f]],
  digit: [[0x30, 0x39]],
  graph: [[0x21, 0x7e]],
  lower: [[0x61, 0x7a]],
  print: [[0x20, 0x7e]],
  punct: [[0x21, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0x7e]],
  space: [[0x09, 0x0d], [0x20, 0x20]],
  upper: [[0x41, 0x5a]],
  word: [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]],
  xdigit: [[0x30, 0x39], [0x41, 0x46], [0x61, 0x66]],
};

export interface Re2PosixClass {
  /** The source length of `[:name:]` or `[:^name:]`. */
  length: number;
  ranges: ReadonlyArray<readonly [number, number]>;
}

/**
 * The POSIX class `[:name:]` or `[:^name:]` starting at `pos` inside a
 * bracket class, or null. A negated one holds every code point the named
 * one does not.
 */
export function re2PosixClassAt(source: string, pos: number): Re2PosixClass | null {
  const found = /^\[:(\^?)([a-z]+):\]/.exec(source.slice(pos, pos + 12));
  if (found === null) return null;
  const ranges = RE2_POSIX_CLASSES[found[2]!];
  if (ranges === undefined) return null;
  return { length: found[0].length, ranges: found[1] === '^' ? complementRanges(ranges) : ranges };
}

function complementRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  out.push([next, 0x10ffff]);
  return out;
}

/**
 * Spell RE2's POSIX classes inside a bracket class as ranges a JavaScript
 * RegExp reads: `[[:alpha:]]` as `[\x41-\x5a\x61-\x7a]`. A JavaScript engine
 * reads `[[:alpha:]]` as the set `[:alph` followed by a literal `]`. The
 * 2026-10-27 capture `re2-pattern-semantics` and the 2026-11-04 captures
 * `c1-re2-replace-split` (`px0`) and `c9-re2-more` (`px2`) show production
 * reads them as classes. `unicode` says whether the RegExp has the `u`
 * flag; without it a range stops at U+FFFF.
 */
export function spellRe2PosixClasses(source: string, unicode: boolean): string {
  let out = '';
  let inClass = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\' && i + 1 < source.length) {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const posix = inClass ? re2PosixClassAt(source, i) : null;
    if (posix !== null) {
      out += posix.ranges.map(([lo, hi]) => `${classMember(lo, unicode)}-${classMember(hi, unicode)}`).join('');
      i += posix.length;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    out += ch;
    i++;
  }
  return out;
}

function classMember(codePoint: number, unicode: boolean): string {
  if (codePoint <= 0xff) return `\\x${codePoint.toString(16).padStart(2, '0')}`;
  if (unicode) return `\\u{${codePoint.toString(16)}}`;
  return `\\u${Math.min(codePoint, 0xffff).toString(16).padStart(4, '0')}`;
}
