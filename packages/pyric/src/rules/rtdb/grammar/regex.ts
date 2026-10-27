/**
 * RTDB's regular expression dialect: the load-time check and the matcher
 * behind `matches(/.../)`.
 *
 * Production's dialect is not JavaScript's. The Firebase reference
 * (https://firebase.google.com/docs/reference/security/database/regex) lists
 * `\d \w \s` and their negations, a backslash that "makes the next character
 * literal", `^` only as the first character and `$` only as the last, `.`,
 * `* + ?`, `{n,m}`, groups, `|`, and character sets. The 2026-10-26 captures
 * (#1247) fit a dk.brics.automaton style matcher behind an anchor rewrite:
 *
 *   - a leading `^` and a trailing `$` are stripped; a missing one becomes
 *     `.*`, so `/(/` is parsed as `.*(.*` and fails "expected ')' at
 *     position 5" (r44), `/^\p{L}+$/` is parsed as `\p{L}+` and fails
 *     "integer expected at position 3" (r46), `/^(a$/` is parsed as `(a` and
 *     fails at position 2, and `/^)/` reads `)` as a literal (r53);
 *   - any other unescaped `^` or `$` is refused at deploy (r46, r51, SP-1);
 *   - `\b` reads as `b` and `\1` as `1`; `(?=x)` and `(?!x)` read `?` as a
 *     literal, so they never match where JavaScript would (r47, r50, SP-2b);
 *   - `.` matches every character, `\n` and `\r` included (r47, r50, SP-8);
 *   - `\p{..}` is a `p` followed by a repeat count, refused (r46, SP-2a);
 *   - `\s \w \d` are ASCII, `i` adds each pattern character's own upper and
 *     lower case, and `& ~ # @ >` are plain characters (r56).
 *
 * The parse builds a `RegexNode` tree for the shared linear-time matcher in
 * `rules/simulator/regex-nfa.ts`, so `^(a+)+$` never backtracks (LD-6).
 *
 * Not yet observed, and read as plain characters like the five r56 covers:
 * `"` and `<`, which r57 asks about.
 */
import { compileRegexNode, type RegexMatcher, type RegexNode } from '../../simulator/regex-nfa.js';
import { DialectParser, ILLEGAL, RtdbRegexSyntaxError } from './regex-parser.js';
import { stateCount } from './regex-limits.js';

export { RtdbRegexSyntaxError } from './regex-parser.js';
export { MAX_REGEX_NESTING, MAX_REGEX_STATES, MAX_REPEAT_COUNT } from './regex-limits.js';

/** Production's deploy error for a `^` that is not first or a `$` that is not last (r46, r51). */
export const MISPLACED_ANCHOR_MESSAGE = `${ILLEGAL}unescaped ^, ^ can only appear at the end of regular expressions`;

/** A compiled `matches()` argument. Its matcher is built on the first `test`. */
export class RtdbRegex {
  private matcher: RegexMatcher | undefined;

  constructor(
    readonly source: string,
    readonly flags: string,
    private readonly node: RegexNode,
  ) {}

  /** Whether `subject` matches, as production's `matches()` decides. */
  test(subject: string): boolean {
    this.matcher ??= compileRegexNode(this.node);
    return this.matcher(subject.split(''));
  }
}

/**
 * The error that refuses regex literal `body` at load, or null when it loads.
 * Parses only; no matcher is built.
 */
export function rtdbRegexError(body: string): string | null {
  try {
    parseRtdbRegex(body, false);
    return null;
  } catch (error) {
    if (error instanceof RtdbRegexSyntaxError) return error.message;
    throw error;
  }
}

/** The most matcher states the compiled-regex cache holds before it starts over. */
const CACHE_STATE_LIMIT = 1000000;
const compiled = new Map<string, RtdbRegex>();
let cachedStates = 0;

/**
 * Compile regex literal `body` with `flags` (already checked by
 * `isSupportedRegexFlags`). Throws `RtdbRegexSyntaxError` with production's
 * deploy error text when production refuses the pattern.
 */
export function compileRtdbRegex(body: string, flags: string): RtdbRegex {
  const key = `${flags}/${body}`;
  const cached = compiled.get(key);
  if (cached) return cached;
  const node = parseRtdbRegex(body, flags.includes('i'));
  const regex = new RtdbRegex(body, flags, node);
  const states = stateCount(node);
  if (cachedStates + states > CACHE_STATE_LIMIT) {
    compiled.clear();
    cachedStates = 0;
  }
  compiled.set(key, regex);
  cachedStates += states;
  return regex;
}

function parseRtdbRegex(body: string, ignoreCase: boolean): RegexNode {
  return new DialectParser(anchoredSource(body), ignoreCase).parse();
}

/**
 * The pattern production parses: a leading `^` and a trailing unescaped `$`
 * removed, `.*` in place of each that is missing. Any other unescaped `^` or
 * `$` outside a character set is refused.
 */
function anchoredSource(body: string): string {
  const startsAnchored = body.startsWith('^');
  let core = startsAnchored ? body.slice(1) : body;
  const endsAnchored = endsWithUnescapedDollar(core);
  if (endsAnchored) core = core.slice(0, -1);
  if (hasMisplacedAnchor(core)) throw new RtdbRegexSyntaxError(MISPLACED_ANCHOR_MESSAGE);
  const prefix = startsAnchored ? '' : '.*';
  const suffix = endsAnchored ? '' : '.*';
  return `${prefix}${core}${suffix}`;
}

function endsWithUnescapedDollar(source: string): boolean {
  if (!source.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

function hasMisplacedAnchor(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') i += 2;
    else if (ch === '[') i = afterCharacterSet(source, i);
    else if (ch === '^' || ch === '$') return true;
    else i++;
  }
  return false;
}

/** The index after the character set opening at `open`; its first member may be `]`. */
function afterCharacterSet(source: string, open: number): number {
  let i = open + 1;
  if (source[i] === '^') i++;
  let first = true;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ']' && !first) return i + 1;
    i += ch === '\\' ? 2 : 1;
    first = false;
  }
  return i;
}

