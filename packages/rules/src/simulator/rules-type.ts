import { findInvalidRe2EscapeOrClass } from '../grammar/re2-escape-validation.js';
import {
  findInvalidRe2CharClassRange,
  normalizeRe2ForJsRegExp,
  re2PosixClassAt,
  scanRe2Pattern,
  spellRe2PosixClasses,
  spellRe2SpaceClasses,
} from '../grammar/re2-pattern.js';
import { re2CaseFoldOrbit } from './re2-case-fold.js';
import {
  compileCharMatcher,
  spellRe2BellEscapes,
  spellRe2UnicodeClasses,
} from './re2-char-matcher.js';
import { FirestoreSet } from './firestore-set.js';
import { MapDiff } from './mapdiff.js';
import {
  CodePointSubject,
  compileRegexSearch,
  matchesRegexNode,
  type RegexNode,
  type RegexSearch,
  type UnitMatch,
} from './regex-nfa.js';
import { MAX_REGEX_NESTING, MAX_REGEX_STATES, NESTING_MESSAGE, stateCount } from '../rtdb/grammar/regex-limits.js';
import { RulesValue } from './wrappers/base.js';
import { isRulesInt } from './rules-int.js';

/** A Rules map is a plain key/value record, never a boxed scalar/wrapper. */
export function isRulesMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The Rules type name of a value, as production's error messages spell it. */
export function describeRulesType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof RulesValue) return value.typeName === 'reference' ? 'path' : value.typeName;
  if (value instanceof FirestoreSet) return 'set';
  if (value instanceof MapDiff) return 'map_diff';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return isRulesInt(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'list';
  if (isRulesMap(value)) return 'map';
  return typeof value;
}

// === Linear-time RE2 regex evaluation & Java Matcher replacement ===

function isWordChar(chars: readonly string[], idx: number): boolean {
  const ch = idx >= 0 && idx < chars.length ? chars[idx] : undefined;
  if (ch === undefined || ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** Production's text for a regex literal it refuses at deploy. */
export function invalidPatternMessage(pattern: string): string {
  return `Invalid regular expression pattern. Pattern: ${pattern}.`;
}

/**
 * The refusal for a pattern that expands past pyric's matcher state limit,
 * or null. That limit bounds the matcher's memory (#1264). The
 * character-position limit RTDB's deploy refuses past (#1261) does not
 * apply: Firestore compiles `(a{1000}){11}`, ten `a{1000}` then `b`, and
 * `((a{100}){100}){10}`, which expand to 11,000, 10,001 and 100,000
 * characters (#1897, captures `k5`, `k6` and `k9` in
 * `test/rules/grammar/fixtures/size-limits/captures.json`). A pattern's
 * state count is at least its position count, so every pattern within the
 * state limit has at most 200,000 positions. Production's own threshold
 * has not been measured.
 */
export function re2SizeRefusal(pattern: string, ast: RegexNode): string | null {
  if (stateCount(ast) <= MAX_REGEX_STATES) return null;
  return (
    `${invalidPatternMessage(pattern)} pyric refuses patterns that expand past ` +
    `${MAX_REGEX_STATES.toLocaleString('en-US')} matcher states, a limit of pyric; ` +
    `production's limit has not been measured.`
  );
}

/** Parse `pattern`, throwing when it expands past pyric's size limits. */
function parseSizedRe2Ast(pattern: string): RegexNode {
  const ast = parseRe2Ast(pattern);
  const sizeRefusal = re2SizeRefusal(pattern, ast);
  if (sizeRefusal !== null) throw new Error(sizeRefusal);
  return ast;
}

function unsupportedConstructError(method: string, construct: string): Error {
  return new Error(`${method}() pattern uses an RE2-unsupported construct (${construct}) that production would reject`);
}

/** A pattern compiled for `split()` and `replace()`, with its capture groups. */
export interface Re2Search {
  search: RegexSearch;
  groupCount: number;
  /** Each named group's number, from `(?P<name>...)` or `(?<name>...)`. */
  groupNames: ReadonlyMap<string, number>;
}

/**
 * Validate and compile a rules RE2 pattern for `split()` or `replace()`,
 * with the checks `matches()` gives it: RE2's refusal of backreferences and
 * lookaround, JavaScript's syntax check, and pyric's size limits. The search
 * runs on the linear matcher `matches()` uses.
 */
export function compileRe2Search(method: string, pattern: string): Re2Search {
  // The scan skips escapes and classes, so `\\1` and `[(?=]` are literals.
  const { unsupported } = scanRe2Pattern(pattern);
  if (unsupported !== null) throw unsupportedConstructError(method, unsupported);
  const compileError = re2PatternCompileError(pattern);
  if (compileError !== null) throw new Error(`Invalid regex '${pattern}' in ${method}(): ${compileError}`);
  const parsed = parseRe2Pattern(pattern);
  const sizeRefusal = re2SizeRefusal(pattern, parsed.ast);
  if (sizeRefusal !== null) throw new Error(sizeRefusal);
  return { search: compileRegexSearch(parsed.ast), groupCount: parsed.groupCount, groupNames: parsed.groupNames };
}

/**
 * Evaluate `subject.matches(pattern)` (full-string RE2 match) in guaranteed
 * O(M * N) time using a Thompson NFA state-set simulation so patterns with
 * nested quantifiers like `((a+)+)b` never backtrack catastrophically.
 */
export function re2FullMatch(pattern: string, subject: string): boolean {
  const { unsupported } = scanRe2Pattern(pattern);
  if (unsupported !== null) throw unsupportedConstructError('matches', unsupported);
  const compileError = re2PatternCompileError(pattern);
  if (compileError !== null) throw new Error(`Invalid regex '${pattern}' in matches(): ${compileError}`);
  return matchesRegexNode(parseSizedRe2Ast(pattern), Array.from(subject));
}

/**
 * Whether JavaScript compiles `pattern`, read as code units or, failing that,
 * as code points with RE2's property classes spelled for a `u` RegExp. A
 * class range over characters outside the Basic Multilingual Plane, such as
 * `[\u{1F600}-\u{1F602}]`, compiles only as code points; production compiles it (#1901,
 * capture `c9b-astral-range-matches`). Throws on a pattern
 * `normalizeRe2ForJsRegExp` refuses.
 */
export function re2PatternCompiles(pattern: string): boolean {
  return re2PatternCompileError(pattern) === null;
}

/** Why RE2 or JavaScript refuses `pattern`, or null. */
function re2PatternCompileError(pattern: string): string | null {
  const escapeError = findInvalidRe2EscapeOrClass(pattern);
  if (escapeError !== null) return escapeError;
  const rangeError = findInvalidRe2CharClassRange(pattern);
  if (rangeError !== null) return rangeError;
  const normalized = spellRe2BellEscapes(normalizeRe2ForJsRegExp(pattern));
  const codeUnitError = jsRegExpError(`^(?:${normalized})$`, '');
  if (codeUnitError === null) return null;
  const unicodeSource = spellRe2SpaceClasses(
    spellRe2UnicodeClasses(spellRe2PosixClasses(normalized, true)),
    true,
  );
  if (jsRegExpError(`^(?:${unicodeSource})$`, 'u') === null) return null;
  return codeUnitError;
}

function jsRegExpError(source: string, flags: string): string | null {
  try {
    new RegExp(source, flags);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Parse an RE2 pattern into the matcher's tree, refusing a repeat count over 1000. */
export function parseRe2Ast(pattern: string): RegexNode {
  return parseRe2Pattern(pattern).ast;
}

/** An RE2 pattern's tree and its capture groups. */
interface ParsedRe2Pattern {
  ast: RegexNode;
  groupCount: number;
  groupNames: ReadonlyMap<string, number>;
}

/**
 * Parse an RE2 pattern into the matcher's tree, numbering its capture
 * groups by their opening parenthesis. Each repeat's greediness comes from
 * the same reading: a trailing `?` makes it lazy, and under RE2's `(?U)`
 * flag a repeat is lazy unless it has one. Capture `c1-re2-replace-split`
 * (`ug0`, `ug1`) shows production reads `(?U)` so (#1891).
 */
function parseRe2Pattern(pattern: string): ParsedRe2Pattern {
  const escapeError = findInvalidRe2EscapeOrClass(pattern);
  if (escapeError !== null) {
    throw new Error(`Invalid regex '${pattern}': ${escapeError}`);
  }
  const rangeError = findInvalidRe2CharClassRange(pattern);
  if (rangeError !== null) {
    throw new Error(`Invalid regex '${pattern}': ${rangeError}`);
  }
  let pos = 0;
  let depth = 0;
  let ignoreCase = false;
  let multiline = false;
  let dotAll = false;
  let ungreedy = false;
  let groupCount = 0;
  const groupNames = new Map<string, number>();

  const applyFlagString = (flagStr: string) => {
    let clearing = false;
    for (const f of flagStr) {
      if (f === '-') clearing = true;
      else if (f === 'i') ignoreCase = !clearing;
      else if (f === 'm') multiline = !clearing;
      else if (f === 's') dotAll = !clearing;
      else if (f === 'U') ungreedy = !clearing;
    }
  };

  const balancedAlternation = (alts: readonly RegexNode[], from: number, to: number): RegexNode => {
    if (to - from === 1) return alts[from]!;
    const mid = from + Math.floor((to - from) / 2);
    return { kind: 'alt', left: balancedAlternation(alts, from, mid), right: balancedAlternation(alts, mid, to) };
  };

  const parseAlternation = (): RegexNode => {
    const alts: RegexNode[] = [parseConcat()];
    while (pos < pattern.length && pattern[pos] === '|') {
      pos++;
      alts.push(parseConcat());
    }
    return balancedAlternation(alts, 0, alts.length);
  };

  const parseConcat = (): RegexNode => {
    const items: RegexNode[] = [];
    while (pos < pattern.length && pattern[pos] !== '|' && pattern[pos] !== ')') {
      const quoted = pattern.startsWith('\\Q', pos);
      if (quoted) items.push(...parseQuoted());
      else items.push(parseQuantified());
    }
    if (items.length === 0) return { kind: 'empty' };
    const single = items[0];
    if (items.length === 1 && single !== undefined) return single;
    return { kind: 'seq', items };
  };

  /**
   * `\Q...\E`: the text up to `\E`, or to the end, as literal characters.
   * A repeat after it applies to its last character, as RE2 reads it.
   */
  const parseQuoted = (): RegexNode[] => {
    const close = pattern.indexOf('\\E', pos + 2);
    const end = close === -1 ? pattern.length : close;
    const literals = Array.from(pattern.slice(pos + 2, end)).map((ch) => matchLiteralChar(ch, ignoreCase));
    pos = close === -1 ? end : end + 2;
    const last = literals.pop();
    if (last === undefined) return [];
    return [...literals, parseQuantified(last)];
  };

  /** Whether the repeat just read is greedy, reading its lazy `?` if it has one. */
  const readGreedy = (): boolean => {
    const lazySuffix = pattern[pos] === '?';
    if (lazySuffix) pos++;
    return lazySuffix === ungreedy;
  };

  const parseQuantified = (atom?: RegexNode): RegexNode => {
    let node = atom ?? parseAtom();
    let quantifiers = 0;
    while (pos < pattern.length) {
      const ch = pattern[pos];
      if (ch === '*' || ch === '+' || ch === '?') {
        quantifiers++;
        if (depth + quantifiers > MAX_REGEX_NESTING) {
          throw new Error(`${invalidPatternMessage(pattern)} ${NESTING_MESSAGE}`);
        }
        pos++;
        const greedy = readGreedy();
        let min = 0;
        let max = Infinity;
        if (ch === '+') min = 1;
        else if (ch === '?') max = 1;
        node = { kind: 'rep', body: node, min, max, greedy };
      } else if (ch === '{') {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(pos));
        if (!m) break;
        quantifiers++;
        if (depth + quantifiers > MAX_REGEX_NESTING) {
          throw new Error(`${invalidPatternMessage(pattern)} ${NESTING_MESSAGE}`);
        }
        pos += m[0].length;
        const greedy = readGreedy();
        const min = Number(m[1]);
        let max = min;
        if (m[2] !== undefined) {
          max = m[2] === '' ? Infinity : Number(m[2]);
        }
        if (min > max || min > 1000 || (max !== Infinity && max > 1000)) {
          throw new Error(`Invalid repeat count in '${pattern}'`);
        }
        node = { kind: 'rep', body: node, min, max, greedy };
      } else {
        break;
      }
    }
    return node;
  };

  const matchLiteralChar = (target: string, caseInsensitive: boolean): RegexNode => {
    if (caseInsensitive) {
      const orbit = re2CaseFoldOrbit(target);
      if (orbit.length === 1) {
        return { kind: 'char', test: (c) => c === target };
      }
      return { kind: 'char', test: (c) => orbit.includes(c) };
    }
    return { kind: 'char', test: (c) => c === target };
  };

  const parseAtom = (): RegexNode => {
    const ch = pattern[pos] ?? '';
    if (ch === '(') {
      pos++;
      const savedI = ignoreCase;
      const savedM = multiline;
      const savedS = dotAll;
      const savedU = ungreedy;
      let capture: number | undefined;
      if (pattern[pos] !== '?') capture = ++groupCount;
      if (pattern[pos] === '?') {
        pos++;
        if (pattern[pos] === ':') {
          pos++;
        } else if (pattern[pos] === '<' || (pattern[pos] === 'P' && pattern[pos + 1] === '<')) {
          const nameStart = pattern.indexOf('<', pos) + 1;
          const closeGt = pattern.indexOf('>', pos);
          capture = ++groupCount;
          groupNames.set(pattern.slice(nameStart, closeGt), capture);
          pos = closeGt + 1;
        } else {
          const flagMatch = /^[imsU-]+/.exec(pattern.slice(pos));
          if (flagMatch) {
            applyFlagString(flagMatch[0]);
            pos += flagMatch[0].length;
            if (pattern[pos] === ')') {
              pos++;
              return { kind: 'empty' };
            }
            if (pattern[pos] === ':') pos++;
          }
        }
      }
      depth++;
      if (depth > MAX_REGEX_NESTING) {
        throw new Error(`${invalidPatternMessage(pattern)} ${NESTING_MESSAGE}`);
      }
      const inner = parseAlternation();
      depth--;
      if (pattern[pos] === ')') pos++;
      ignoreCase = savedI;
      multiline = savedM;
      dotAll = savedS;
      ungreedy = savedU;
      if (capture === undefined) return inner;
      return { kind: 'seq', items: [inner], capture };
    }
    if (ch === '[') {
      const start = pos;
      pos++;
      if (pattern[pos] === '^') pos++;
      if (pattern[pos] === ']') pos++;
      while (pos < pattern.length && pattern[pos] !== ']') {
        if (pattern[pos] === '\\') pos += 2;
        else pos += re2PosixClassAt(pattern, pos)?.length ?? 1;
      }
      if (pattern[pos] === ']') pos++;
      return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
    }
    if (ch === '^') {
      pos++;
      const isMulti = multiline;
      return {
        kind: 'assert',
        check: (s, p) => p === 0 || (isMulti && p > 0 && s[p - 1] === '\n'),
      };
    }
    if (ch === '$') {
      pos++;
      const isMulti = multiline;
      return {
        kind: 'assert',
        check: (s, p) => p === s.length || (isMulti && p < s.length && s[p] === '\n'),
      };
    }
    if (ch === '.') {
      pos++;
      const allowNl = dotAll;
      // RE2's `.` matches every character but `\n`, so it matches `\r` (FS2-SIM-5a2).
      return { kind: 'char', test: (c) => allowNl || c !== '\n' };
    }
    if (ch === '\\') {
      const start = pos;
      pos++;
      const esc = pattern[pos] ?? '';
      if (esc === 'b') {
        pos++;
        return { kind: 'assert', check: (s, p) => isWordChar(s, p - 1) !== isWordChar(s, p) };
      }
      if (esc === 'B') {
        pos++;
        return { kind: 'assert', check: (s, p) => isWordChar(s, p - 1) === isWordChar(s, p) };
      }
      if (esc === 'A') {
        pos++;
        return { kind: 'assert', check: (_s, p) => p === 0 };
      }
      if (esc === 'z') {
        pos++;
        return { kind: 'assert', check: (s, p) => p === s.length };
      }
      if (esc === 'x' && pattern[pos + 1] === '{') {
        const closeBrace = pattern.indexOf('}', pos + 2);
        const hex = pattern.slice(pos + 2, closeBrace);
        pos = closeBrace + 1;
        return matchLiteralChar(String.fromCodePoint(parseInt(hex, 16)), ignoreCase);
      }
      if ((esc === 'p' || esc === 'P') && /[A-Za-z]/.test(pattern[pos + 1] ?? '')) {
        // A one-letter Unicode class, `\pL` for `\p{L}` (FS2-SIM-5b).
        pos += 2;
        return { kind: 'char', test: compileCharMatcher(`\\${esc}{${pattern[pos - 1]}}`, ignoreCase) };
      }
      if ((esc === 'p' || esc === 'P') && pattern[pos + 1] === '{') {
        const closeBrace = pattern.indexOf('}', pos + 2);
        pos = closeBrace + 1;
        const rawEsc = pattern.slice(start, pos);
        return { kind: 'char', test: compileCharMatcher(rawEsc, ignoreCase) };
      }
      if (esc === 'a') {
        pos++;
        return matchLiteralChar('\x07', false);
      }
      if (esc === 'd' || esc === 'D' || esc === 'w' || esc === 'W' || esc === 's' || esc === 'S' || esc === 't' || esc === 'n' || esc === 'r' || esc === 'v' || esc === 'f') {
        pos++;
        const rawEsc = pattern.slice(start, pos);
        return { kind: 'char', test: compileCharMatcher(rawEsc, ignoreCase) };
      }
      if (esc === 'x') {
        pos += 3;
        return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
      }
      if (esc >= '0' && esc <= '7') {
        let octLen = 1;
        const oct1 = pattern[pos + 1];
        if (oct1 !== undefined && oct1 >= '0' && oct1 <= '7') {
          octLen = 2;
          const oct2 = pattern[pos + 2];
          if (esc <= '3' && oct2 !== undefined && oct2 >= '0' && oct2 <= '7') {
            octLen = 3;
          }
        }
        pos += octLen;
        return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
      }
      const cp = pattern.codePointAt(pos) ?? 0;
      const lit = String.fromCodePoint(cp);
      pos += lit.length;
      return matchLiteralChar(lit, ignoreCase);
    }
    const cp = pattern.codePointAt(pos) ?? 0;
    const fullCh = String.fromCodePoint(cp);
    pos += fullCh.length;
    return matchLiteralChar(fullCh, ignoreCase);
  };

  return { ast: parseAlternation(), groupCount, groupNames };
}

/**
 * Evaluate `subject.replace(pattern, replacement)` with Java `Matcher`
 * replacement template rules (`$n`, `${name}`, `\c`). The pattern runs on
 * the linear matcher `split()` uses and reads the subject as code points, so
 * scoped flags (#1332), `(?U)` (#1891), RE2's classes and `\Q..\E`
 * (#2211), an astral character (#1890), and `\z` and `\A` under `(?m)`
 * (#1892) read as capture `c1-re2-replace-split` shows production reads
 * them. After an empty match the search moves on one code unit, as
 * `split()`'s does, and an empty match right after a match still counts:
 * `em1` there shows `'abc'.replace('b*', '-') == '-a--c-'`.
 */
export function replaceRe2(subject: string, pattern: string, replacement: string): string {
  const { search, groupCount, groupNames } = compileRe2Search('replace', pattern);
  const text = new CodePointSubject(subject, search);
  let out = '';
  let copied = 0;
  let from = 0;
  while (from <= subject.length) {
    const match = text.find(from);
    if (match === null) break;
    const groups = matchGroups(subject, match, groupCount);
    const named = Object.fromEntries([...groupNames].map(([name, index]) => [name, groups[index]]));
    out += subject.slice(copied, match.start) + expandRe2Replacement(replacement, groups, named);
    copied = match.end;
    const empty = match.end === match.start;
    from = empty ? match.end + 1 : match.end;
  }
  return out + subject.slice(copied);
}

/** The match's text, then each group's text or undefined, by group number. */
function matchGroups(subject: string, match: UnitMatch, groupCount: number): Array<string | undefined> {
  const groups: Array<string | undefined> = [subject.slice(match.start, match.end)];
  for (let index = 1; index <= groupCount; index++) {
    const span = match.group(index);
    groups.push(span === undefined ? undefined : subject.slice(span.start, span.end));
  }
  return groups;
}

function expandRe2Replacement(
  template: string,
  groups: ReadonlyArray<string | undefined>,
  namedGroups: Readonly<Record<string, string | undefined>>,
): string {
  const groupCount = groups.length - 1;
  let out = '';
  let i = 0;
  while (i < template.length) {
    const char = template[i];
    if (char === '\\') {
      if (i + 1 >= template.length) {
        throw new Error('replace() replacement ends with an escape character');
      }
      out += template[i + 1];
      i += 2;
      continue;
    }
    if (char !== '$') {
      out += char;
      i += 1;
      continue;
    }
    const next = template[i + 1];
    if (next === '{') {
      const close = template.indexOf('}', i + 2);
      if (close === -1) {
        throw new Error(`replace() replacement has an unclosed group name: ${template.slice(i)}`);
      }
      const name = template.slice(i + 2, close);
      if (!Object.hasOwn(namedGroups, name)) {
        throw new Error(`replace() replacement names no group: ${template.slice(i, close + 1)}`);
      }
      out += namedGroups[name] ?? '';
      i = close + 1;
      continue;
    }
    if (next === undefined || next < '0' || next > '9') {
      throw new Error(`replace() replacement has an illegal group reference: ${template.slice(i)}`);
    }
    let group = Number(next);
    let end = i + 2;
    while (end < template.length) {
      const digit = template[end];
      if (digit === undefined || digit < '0' || digit > '9') break;
      const longer = group * 10 + Number(digit);
      if (longer > groupCount) break;
      group = longer;
      end += 1;
    }
    if (group > groupCount) {
      throw new Error(`replace() replacement names group ${group}, but the pattern has ${groupCount}`);
    }
    out += groups[group] ?? '';
    i = end;
  }
  return out;
}
