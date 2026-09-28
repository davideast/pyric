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
 * for the caller's own stack.
 *
 * It is a limit of this parser, not a production limit. Production rejects a
 * Firestore or Storage expression nested 99 levels deep in parenthesized
 * groups, list literals, map literals or function calls, each of which adds a
 * level ("Expression is too complex to evaluate safely.", captured in
 * `test/rules/linter/fixtures/compile-limits/captures.json`), and the parser
 * empties the content past that level before this bound applies
 * (`boundSourceNesting`). What remains to reach this bound is index access,
 * method call arguments, and match blocks, whose production limit is not
 * measured.
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

/**
 * What a bracket opens, in Firestore and Storage rules.
 *
 * - `group`: a parenthesized group.
 * - `call`: the argument list of a function call or a function declaration.
 * - `method`: the argument list of a method call (`x.size()`).
 * - `interpolation`: a `$(` path interpolation.
 * - `list`: a list literal.
 * - `index`: index or slice access (`x[0]`).
 * - `map`: a map literal.
 * - `block`: the body of a service, match block, or function, or a path wildcard.
 */
export type BracketKind = 'group' | 'call' | 'method' | 'interpolation' | 'list' | 'index' | 'map' | 'block';

/** One opening bracket and where it closes. */
export interface BracketSpan {
  char: '(' | '[' | '{';
  kind: BracketKind;
  /** Offset of the opening bracket. */
  open: number;
  /** Offset of the matching closing bracket, or -1 when the source ends first. */
  close: number;
  /** Brackets of any kind enclosing the bracket's content, itself included. */
  depth: number;
  /**
   * Level-adding brackets enclosing the bracket's content, itself included
   * when it is one: groups, function call arguments, list literals and map
   * literals, each of which puts what it encloses one production nesting
   * level deeper.
   */
  levels: number;
  /** Comma-separated items directly inside: list elements, map entries, call arguments. */
  items: number;
}

/** Words after which a bracket opens an operand, not an argument list, an index, or a block. */
const KEYWORDS = new Set(['if', 'return', 'in', 'is', 'let', 'true', 'false', 'null']);

/** The bracket kinds that put their content one nesting level deeper. */
const LEVEL_KINDS: ReadonlySet<BracketKind> = new Set(['group', 'call', 'list', 'map']);

type Previous = 'none' | 'word' | 'dollar' | 'operand' | 'slash' | 'other';

const isWordChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

interface OpenSpan {
  span: BracketSpan;
  commas: number;
  /** Whether a token followed the last comma, or the opening bracket when there is none. */
  tail: boolean;
}

/** Every opening bracket in `source`, in source order. */
export function scanBrackets(source: string, options: BracketScanOptions): BracketSpan[] {
  const spans: BracketSpan[] = [];
  const stack: OpenSpan[] = [];
  let levels = 0;
  let previous: Previous = 'none';
  let word = '';
  let wordAfterDot = false;
  let lastSignificant = '';
  const n = source.length;
  let i = 0;
  /** Marks the innermost open bracket as holding a token after its last comma. */
  const content = () => {
    const top = stack[stack.length - 1];
    if (top !== undefined) top.tail = true;
  };
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
    // Any token but a closing bracket or a comma is an item of the innermost bracket.
    if (c !== 41 && c !== 93 && c !== 125 && c !== 44) content();
    // String literals; a bytes prefix is read as a word before it.
    if (c === 39 || c === 34) {
      i = skipQuoted(source, i, c, !options.multilineStrings);
      previous = 'operand';
      lastSignificant = '';
      continue;
    }
    // Regular expression literals, where an operand may start.
    if (options.regexLiterals && c === 47 && previous !== 'word' && previous !== 'operand') {
      i = skipQuoted(source, i, 47, true);
      while (i < n && isWordChar(source.charCodeAt(i))) i++;
      previous = 'operand';
      lastSignificant = '';
      continue;
    }
    if (isWordChar(c) && c !== 36) {
      const start = i;
      while (i < n && isWordChar(source.charCodeAt(i))) i++;
      word = source.slice(start, i);
      wordAfterDot = lastSignificant === '.';
      previous = c >= 48 && c <= 57 ? 'operand' : 'word';
      lastSignificant = '';
      continue;
    }
    if (c === 36 /* $ */) {
      const next = source.charCodeAt(i + 1);
      if (next !== 40 /* ( */ && isWordChar(next)) {
        const start = i;
        i++;
        while (i < n && isWordChar(source.charCodeAt(i))) i++;
        word = source.slice(start, i);
        wordAfterDot = lastSignificant === '.';
        previous = 'word';
        lastSignificant = '';
        continue;
      }
      previous = 'dollar';
      lastSignificant = '$';
      i++;
      continue;
    }
    if (c === 40 || c === 91 || c === 123) {
      const char = c === 40 ? '(' : c === 91 ? '[' : '{';
      const kind = classify(char, previous, word, wordAfterDot);
      const adds = LEVEL_KINDS.has(kind);
      if (adds) levels++;
      const span: BracketSpan = { char, kind, open: i, close: -1, depth: stack.length + 1, levels, items: 0 };
      spans.push(span);
      stack.push({ span, commas: 0, tail: false });
      previous = 'other';
      lastSignificant = char;
      i++;
      continue;
    }
    if (c === 41 || c === 93 || c === 125) {
      const open = stack.pop();
      if (open !== undefined) {
        open.span.close = i;
        open.span.items = open.commas + (open.tail ? 1 : 0);
        if (LEVEL_KINDS.has(open.span.kind)) levels--;
      }
      previous = 'operand';
      lastSignificant = '';
      i++;
      continue;
    }
    if (c === 44 /* , */) {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.commas++;
        top.tail = false;
      }
    }
    previous = c === 47 ? 'slash' : 'other';
    lastSignificant = source[i]!;
    i++;
  }
  // A bracket the source never closes counts the items it opened.
  for (const open of stack) open.span.items = open.commas + (open.tail ? 1 : 0);
  return spans;
}

/** What one opening bracket opens, from the token before it. */
function classify(char: '(' | '[' | '{', previous: Previous, word: string, wordAfterDot: boolean): BracketKind {
  const afterName = previous === 'word' && !KEYWORDS.has(word);
  if (char === '(') {
    if (previous === 'dollar') return 'interpolation';
    if (afterName) return wordAfterDot ? 'method' : 'call';
    return 'group';
  }
  if (char === '[') return afterName || previous === 'operand' ? 'index' : 'list';
  // A `{` after a name, a closing bracket, or a path's `/` opens a block or a
  // path wildcard; anywhere else an operand starts, it opens a map literal.
  return afterName || previous === 'operand' || previous === 'slash' ? 'block' : 'map';
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
