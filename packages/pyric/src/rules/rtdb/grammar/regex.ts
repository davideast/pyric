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
 *     position 5" (r44), and `/^\p{L}+$/` is parsed as `\p{L}+` and fails
 *     "integer expected at position 3" (r46);
 *   - any other unescaped `^` or `$` is refused at deploy (r46, r51, SP-1);
 *   - `\b` reads as `b` and `\1` as `1`; `(?=x)` and `(?!x)` read `?` as a
 *     literal, so they never match where JavaScript would (r47, r50, SP-2b);
 *   - `.` matches every character, `\n` and `\r` included (r47, r50, SP-8);
 *   - `\p{..}` is a `p` followed by a repeat count, refused (r46, SP-2a).
 *
 * The parse builds a `RegexNode` tree for the shared linear-time matcher in
 * `rules/simulator/regex-nfa.ts`, so `^(a+)+$` never backtracks (LD-6).
 *
 * Not yet observed, and kept as close to the previous JavaScript reading as
 * the dialect allows: what `\s` covers (JavaScript's whitespace set here),
 * how `i` folds case, and that `& ~ # @ " < >` are plain characters.
 */
import { matchesRegexNode, type RegexNode } from '../../simulator/regex-nfa.js';

const ILLEGAL = 'Illegal regular expression, ';

/** Production's deploy error for a `^` that is not first or a `$` that is not last (r46, r51). */
export const MISPLACED_ANCHOR_MESSAGE = `${ILLEGAL}unescaped ^, ^ can only appear at the end of regular expressions`;

/** A pattern production refuses at deploy; the message is the deploy error text. */
export class RtdbRegexSyntaxError extends SyntaxError {}

/** A compiled `matches()` argument. */
export class RtdbRegex {
  constructor(
    readonly source: string,
    readonly flags: string,
    private readonly node: RegexNode,
  ) {}

  /** Whether `subject` matches, as production's `matches()` decides. */
  test(subject: string): boolean {
    return matchesRegexNode(this.node, subject.split(''));
  }
}

/** The deploy error production raises for regex literal `body`, or null when it loads. */
export function rtdbRegexError(body: string): string | null {
  try {
    compileRtdbRegex(body, '');
    return null;
  } catch (error) {
    if (error instanceof RtdbRegexSyntaxError) return error.message;
    throw error;
  }
}

const CACHE_LIMIT = 256;
const compiled = new Map<string, RtdbRegex>();

/**
 * Compile regex literal `body` with `flags` (already checked by
 * `isSupportedRegexFlags`). Throws `RtdbRegexSyntaxError` with production's
 * deploy error text when production refuses the pattern.
 */
export function compileRtdbRegex(body: string, flags: string): RtdbRegex {
  const key = `${flags}/${body}`;
  const cached = compiled.get(key);
  if (cached) return cached;
  const regex = new RtdbRegex(body, flags, parseRtdbRegex(body, flags.includes('i')));
  if (compiled.size >= CACHE_LIMIT) compiled.clear();
  compiled.set(key, regex);
  return regex;
}

function parseRtdbRegex(body: string, ignoreCase: boolean): RegexNode {
  const parenError = unbalancedParenError(body);
  if (parenError !== null) throw new RtdbRegexSyntaxError(parenError);
  return new DialectParser(anchoredSource(body), ignoreCase).parse();
}

/**
 * Unmatched parentheses outside character classes. Kept ahead of the dialect
 * parse so the texts stay those pyric reported before: r44 observed only
 * "expected ')' at position 5" for `/(/`, and the positions for anchored or
 * stray parentheses await a capture.
 */
function unbalancedParenError(body: string): string | null {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\') {
      i++;
    } else if (inClass) {
      inClass = ch !== ']';
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth < 0) return `${ILLEGAL}unexpected ')' at position ${i + 2}`;
    }
  }
  if (depth > 0) return `${ILLEGAL}expected ')' at position ${body.length + 4}`;
  return null;
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

type CharTest = (ch: string) => boolean;

/** A single character, or a class like `\d`. */
type Member = { kind: 'char'; ch: string } | { kind: 'class'; test: CharTest };

/** One member of a character set: a `Member`, or a range like `a-z`. */
type SetMember = Member | { kind: 'range'; from: string; to: string };

const NEVER: RegexNode = { kind: 'char', test: () => false };
const ANY: RegexNode = { kind: 'char', test: () => true };
const QUANTIFIERS = '?*+{';
const DIGITS = '0123456789';

const isDigit: CharTest = (ch) => ch >= '0' && ch <= '9';
const isWord: CharTest = (ch) => /^[A-Za-z0-9_]$/.test(ch);
const isSpace: CharTest = (ch) => /^\s$/.test(ch);

const NAMED_CLASSES: Readonly<Record<string, CharTest>> = {
  d: isDigit,
  D: (ch) => !isDigit(ch),
  w: isWord,
  W: (ch) => !isWord(ch),
  s: isSpace,
  S: (ch) => !isSpace(ch),
};

/**
 * A recursive-descent parse of the anchor-rewritten pattern, following the
 * dk.brics.automaton grammar: union, concatenation, repeat, character set,
 * simple expression. A character that starts no other construct, `?` right
 * after `(` among them, is a literal.
 */
class DialectParser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly ignoreCase: boolean,
  ) {}

  parse(): RegexNode {
    const node = this.union();
    if (this.more()) this.fail(`end-of-string expected at position ${this.pos}`);
    return node;
  }

  private union(): RegexNode {
    const left = this.concat();
    if (!this.match('|')) return left;
    return { kind: 'alt', left, right: this.union() };
  }

  private concat(): RegexNode {
    const items = [this.repeat()];
    while (this.more() && !this.peek(')|')) items.push(this.repeat());
    if (items.length === 1) return items[0]!;
    return { kind: 'seq', items };
  }

  private repeat(): RegexNode {
    let node = this.characterSet();
    while (this.peek(QUANTIFIERS)) {
      if (this.match('?')) node = { kind: 'rep', body: node, min: 0, max: 1 };
      else if (this.match('*')) node = { kind: 'rep', body: node, min: 0, max: Infinity };
      else if (this.match('+')) node = { kind: 'rep', body: node, min: 1, max: Infinity };
      else node = this.counted(node);
    }
    return node;
  }

  /** `{n}`, `{n,}` or `{n,m}` after `node`; the `{` is next. */
  private counted(node: RegexNode): RegexNode {
    this.pos++;
    const min = this.integer();
    let max = min;
    if (this.match(',')) max = this.peek(DIGITS) ? this.integer() : Infinity;
    if (!this.match('}')) this.fail(`expected '}' at position ${this.pos}`);
    const emptyRange = min > max;
    if (emptyRange) return NEVER;
    return { kind: 'rep', body: node, min, max };
  }

  private integer(): number {
    const start = this.pos;
    while (this.peek(DIGITS)) this.pos++;
    if (start === this.pos) this.fail(`integer expected at position ${this.pos}`);
    return Number(this.text.slice(start, this.pos));
  }

  private characterSet(): RegexNode {
    if (!this.match('[')) return this.simple();
    const negated = this.match('^');
    const members = [this.setMember()];
    while (this.more() && !this.peek(']')) members.push(this.setMember());
    if (!this.match(']')) this.fail(`expected ']' at position ${this.pos}`);
    const tests = members.map((member) => this.memberTest(member));
    const inSet: CharTest = (ch) => tests.some((test) => test(ch));
    if (negated) return { kind: 'char', test: (ch) => !inSet(ch) };
    return { kind: 'char', test: inSet };
  }

  /**
   * A character set member. A `-` next to a class, or before the closing `]`,
   * is the character `-`.
   */
  private setMember(): SetMember {
    const first = this.charExp();
    if (first.kind === 'class' || !this.match('-')) return first;
    const hyphen: Member = { kind: 'char', ch: '-' };
    if (this.peek(']')) return { kind: 'class', test: this.unionTest([first, hyphen]) };
    const last = this.charExp();
    if (last.kind === 'class') return { kind: 'class', test: this.unionTest([first, hyphen, last]) };
    return { kind: 'range', from: first.ch, to: last.ch };
  }

  private memberTest(member: SetMember): CharTest {
    if (member.kind === 'range') return this.foldCase(inRange(member.from, member.to));
    return this.unionTest([member]);
  }

  private unionTest(members: readonly Member[]): CharTest {
    const tests = members.map((member) => (member.kind === 'class' ? member.test : this.literal(member.ch)));
    return (ch) => tests.some((test) => test(ch));
  }

  private simple(): RegexNode {
    if (this.match('.')) return ANY;
    if (this.match('(')) return this.group();
    const member = this.charExp();
    const test = member.kind === 'class' ? member.test : this.literal(member.ch);
    return { kind: 'char', test };
  }

  /** The rest of a group; the `(` is consumed. `()` is the empty string. */
  private group(): RegexNode {
    if (this.match(')')) return { kind: 'empty' };
    const inner = this.union();
    if (!this.match(')')) this.fail(`expected ')' at position ${this.pos}`);
    return inner;
  }

  /** A character, escaped or not. `\d \D \w \W \s \S` are classes; any other escape is the character itself. */
  private charExp(): Member {
    const escaped = this.match('\\');
    const ch = this.next();
    const named = escaped ? NAMED_CLASSES[ch] : undefined;
    if (named) return { kind: 'class', test: named };
    return { kind: 'char', ch };
  }

  private literal(target: string): CharTest {
    return this.foldCase((ch) => ch === target);
  }

  private foldCase(test: CharTest): CharTest {
    if (!this.ignoreCase) return test;
    return (ch) => test(ch) || test(ch.toLowerCase()) || test(ch.toUpperCase());
  }

  private next(): string {
    if (!this.more()) this.fail('unexpected end-of-string');
    return this.text[this.pos++]!;
  }

  private more(): boolean {
    return this.pos < this.text.length;
  }

  private peek(chars: string): boolean {
    return this.more() && chars.includes(this.text[this.pos]!);
  }

  private match(ch: string): boolean {
    if (this.text[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  private fail(message: string): never {
    throw new RtdbRegexSyntaxError(`${ILLEGAL}${message}`);
  }
}

/** A range by UTF-16 code unit; `[z-a]` is empty, as production loads and never matches it (r44). */
function inRange(from: string, to: string): CharTest {
  return (ch) => ch.length === 1 && ch >= from && ch <= to;
}
