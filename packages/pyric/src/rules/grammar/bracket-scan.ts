/**
 * A linear scan of rules source for its brackets, run before the grammar
 * matches it.
 *
 * The grammars are matched by a recursive descent that uses a stack frame
 * chain per precedence level for every nested bracket, and around 170 to 300
 * nested brackets, depending on the bracket kind and the caller's stack, it
 * exhausts the host stack. The scan finds how deep the source nests without
 * recursing, so a caller can reject or rewrite the source before the match
 * would descend that far.
 *
 * Brackets inside a string literal, a comment, or a regular expression
 * literal are not brackets.
 */

/**
 * Most brackets of any kind (`(`, `[`, `{`) one position in the source may
 * sit inside. The grammars descend far enough below this bound to leave room
 * for the caller's own stack. It is a parser bound, not a production limit.
 */
export const MAX_BRACKET_DEPTH = 128;

export interface BracketScanOptions {
  /** `//` line comments and block comments, as in Firestore and Storage rules. */
  comments: boolean;
  /** `/.../` regular expression literals in operand position, as in RTDB rules. */
  regexLiterals: boolean;
  /** Whether a string literal may span lines. A Firestore string ends at a raw line break. */
  multilineStrings: boolean;
}

/** One opening bracket and where it closes. */
export interface BracketSpan {
  kind: '(' | '[' | '{';
  /** Offset of the opening bracket. */
  open: number;
  /** Offset of the matching closing bracket, or -1 when the source ends first. */
  close: number;
  /**
   * A parenthesized group in Firestore and Storage rules: a `(` that does not
   * open the argument list of a function call, a method call, a function
   * declaration, or a `$(` path interpolation.
   */
  group: boolean;
  /** Brackets of any kind enclosing the bracket's content, itself included. */
  depth: number;
  /** Groups enclosing the bracket's content, itself included when it is one. */
  groupDepth: number;
}

/** Words after which a `(` opens a group, not an argument list. */
const KEYWORDS = new Set(['if', 'return', 'in', 'is', 'let', 'true', 'false', 'null']);

type Previous = 'none' | 'word' | 'dollar' | 'operand' | 'other';

const isWordChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/** Every opening bracket in `source`, in source order. */
export function scanBrackets(source: string, options: BracketScanOptions): BracketSpan[] {
  const spans: BracketSpan[] = [];
  const stack: BracketSpan[] = [];
  let groupDepth = 0;
  let previous: Previous = 'none';
  let word = '';
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source.charCodeAt(i);
    // Whitespace.
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    // Comments.
    if (options.comments && c === 47 /* / */) {
      const next = source.charCodeAt(i + 1);
      if (next === 47) {
        const end = source.indexOf('\n', i + 2);
        i = end === -1 ? n : end;
        continue;
      }
      if (next === 42 /* * */) {
        const end = source.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
    }
    // String literals; a bytes prefix is read as a word before it.
    if (c === 39 || c === 34) {
      i = skipQuoted(source, i, c, !options.multilineStrings);
      previous = 'operand';
      continue;
    }
    // Regular expression literals, where an operand may start.
    if (options.regexLiterals && c === 47 && previous !== 'word' && previous !== 'operand') {
      i = skipQuoted(source, i, 47, true);
      while (i < n && isWordChar(source.charCodeAt(i))) i++;
      previous = 'operand';
      continue;
    }
    if (isWordChar(c) && c !== 36) {
      const start = i;
      while (i < n && isWordChar(source.charCodeAt(i))) i++;
      word = source.slice(start, i);
      previous = c >= 48 && c <= 57 ? 'operand' : 'word';
      continue;
    }
    if (c === 36 /* $ */) {
      const next = source.charCodeAt(i + 1);
      if (next !== 40 /* ( */ && isWordChar(next)) {
        const start = i;
        i++;
        while (i < n && isWordChar(source.charCodeAt(i))) i++;
        word = source.slice(start, i);
        previous = 'word';
        continue;
      }
      previous = 'dollar';
      i++;
      continue;
    }
    if (c === 40 || c === 91 || c === 123) {
      const kind = c === 40 ? '(' : c === 91 ? '[' : '{';
      const group = kind === '(' && previous !== 'dollar' && !(previous === 'word' && !KEYWORDS.has(word));
      if (group) groupDepth++;
      const span: BracketSpan = { kind, open: i, close: -1, group, depth: stack.length + 1, groupDepth };
      spans.push(span);
      stack.push(span);
      previous = 'other';
      i++;
      continue;
    }
    if (c === 41 || c === 93 || c === 125) {
      const span = stack.pop();
      if (span !== undefined) {
        span.close = i;
        if (span.group) groupDepth--;
      }
      previous = 'operand';
      i++;
      continue;
    }
    previous = 'other';
    i++;
  }
  return spans;
}

/** The offset just past a literal opened by `quote` at `start`, honoring backslash escapes. */
function skipQuoted(source: string, start: number, quote: number, endsAtLineBreak: boolean): number {
  const n = source.length;
  let i = start + 1;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === 92 /* \ */) {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (endsAtLineBreak && (c === 10 || c === 13)) return i;
    i++;
  }
  return n;
}
