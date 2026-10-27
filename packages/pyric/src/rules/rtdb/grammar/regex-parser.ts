/**
 * The parser for RTDB's regex dialect, over a pattern `regex.ts` has already
 * anchor-rewritten. It follows the dk.brics.automaton grammar (union,
 * concatenation, repeat, character set, simple expression) and builds the
 * `RegexNode` tree the shared matcher in `rules/simulator/regex-nfa.ts` runs.
 * Errors use production's deploy texts, except the pyric limits in
 * `regex-limits.ts`.
 */
import type { RegexNode } from '../../simulator/regex-nfa.js';
import {
  MAX_REGEX_NESTING,
  MAX_REGEX_STATES,
  MAX_REPEAT_COUNT,
  NESTING_MESSAGE,
  STATES_MESSAGE,
  repeatCountMessage,
  stateCount,
} from './regex-limits.js';

export const ILLEGAL = 'Illegal regular expression, ';

/** A pattern production refuses at deploy, or one past a pyric limit; the message says which. */
export class RtdbRegexSyntaxError extends SyntaxError {}

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
export class DialectParser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly text: string,
    private readonly ignoreCase: boolean,
  ) {}

  parse(): RegexNode {
    // An empty pattern, such as `/^$/` once its anchors are stripped, is the
    // empty string (r55).
    if (!this.more()) return { kind: 'empty' };
    const node = this.union();
    // Production reports no position for this one (r53: `/)/`, `/a)b/`).
    if (this.more()) this.fail('end-of-string expected');
    if (stateCount(node) > MAX_REGEX_STATES) this.refuse(STATES_MESSAGE);
    return node;
  }

  /**
   * `a|b|c`, read in a loop and joined as a balanced tree, so a long
   * alternation neither recurses per alternative here nor in the matcher.
   */
  private union(): RegexNode {
    const alternatives = [this.concat()];
    while (this.match('|')) alternatives.push(this.concat());
    return balancedAlternation(alternatives, 0, alternatives.length);
  }

  private concat(): RegexNode {
    const items = [this.repeat()];
    while (this.more() && !this.peek(')|')) items.push(this.repeat());
    if (items.length === 1) return items[0]!;
    return { kind: 'seq', items };
  }

  private repeat(): RegexNode {
    let node = this.characterSet();
    let quantifiers = 0;
    while (this.peek(QUANTIFIERS)) {
      quantifiers++;
      if (this.depth + quantifiers > MAX_REGEX_NESTING) this.refuse(NESTING_MESSAGE);
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
    const digits = this.text.slice(start, this.pos);
    const count = Number(digits);
    if (count > MAX_REPEAT_COUNT) this.refuse(repeatCountMessage(digits));
    return count;
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
    this.depth++;
    if (this.depth > MAX_REGEX_NESTING) this.refuse(NESTING_MESSAGE);
    const inner = this.union();
    this.depth--;
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

  /** Refuse with a message of pyric's own, not production's deploy text. */
  private refuse(message: string): never {
    throw new RtdbRegexSyntaxError(message);
  }
}

/** A range by UTF-16 code unit; `[z-a]` is empty, as production loads and never matches it (r44). */
function inRange(from: string, to: string): CharTest {
  return (ch) => ch.length === 1 && ch >= from && ch <= to;
}

function balancedAlternation(alternatives: readonly RegexNode[], from: number, to: number): RegexNode {
  if (to - from === 1) return alternatives[from]!;
  const middle = from + Math.floor((to - from) / 2);
  return {
    kind: 'alt',
    left: balancedAlternation(alternatives, from, middle),
    right: balancedAlternation(alternatives, middle, to),
  };
}
