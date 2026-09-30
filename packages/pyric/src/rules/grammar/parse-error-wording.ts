/**
 * What a parse failure says it wanted.
 *
 * The parser reports its rightmost failure as the set of terminals that could
 * have continued the match, which for a missing semicolon is nineteen of them:
 * `";", "[", ".", "%", "/", "*", "<", ">", "<=", ">=", "-", "+", "is", "in",
 * "!=", "==", "&&", "?", or "||"`. That set is the parser's own state, not the
 * edit the source needs, and a reader who is handed it reads the whole list
 * before working out that a semicolon is missing.
 *
 * So the set is read for the one terminal that decides the edit, and the
 * source before the failure says which construct the parser was inside when
 * it stopped. Where neither is decidable the wording says `syntax error` and
 * lets the line and column carry the whole message, which is still more than
 * a list of nineteen alternatives.
 */

/** One parse failure, as the grammar reports it. */
export interface ParseFailurePosition {
  line: number;
  column: number;
  expected: string;
}

/** One word or punctuation character of the source, outside comments and strings. */
interface Token {
  text: string;
  offset: number;
  line: number;
}

/** The keywords that open a statement a `;` terminates, and what each statement is. */
const STATEMENTS: Readonly<Record<string, string>> = {
  allow: 'the allow statement',
  let: 'the let binding',
  return: 'the return expression',
  rules_version: 'the version line',
};

/** The keywords that open a braced block, and what each block is. */
const BLOCKS: Readonly<Record<string, string>> = {
  service: 'the service block',
  match: 'the match block',
  function: 'the function body',
};

/** What a `{` that no block keyword introduced opens, which is an expression's map literal. */
const MAP_LITERAL = 'the map literal';

/** How a missing terminator is worded when no statement before it is open. */
const UNNAMED_STATEMENT = 'at the end of the statement';

/**
 * How many alternatives a reader can still act on. A set this size is a
 * vocabulary, such as the allow verbs a match block takes, and reading it is
 * the fastest way to the edit. Past it the set is the parser's state.
 */
const READABLE_ALTERNATIVES = 8;

/** The source offset of a one-based line and column. */
function offsetOf(source: string, line: number, column: number): number {
  let offset = 0;
  for (let at = 1; at < line; at++) {
    const newline = source.indexOf('\n', offset);
    if (newline === -1) return source.length;
    offset = newline + 1;
  }
  return Math.min(source.length, offset + column - 1);
}

/**
 * The tokens of `source` that start before `end`. Comments and string
 * literals are skipped whole, so a keyword or brace inside either is not read
 * as structure.
 */
function tokensBefore(source: string, end: number): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let at = 0;
  while (at < end) {
    const ch = source[at]!;
    if (ch === '\n') {
      line++;
      at++;
    } else if (/\s/.test(ch)) {
      at++;
    } else if (source.startsWith('//', at)) {
      while (at < source.length && source[at] !== '\n') at++;
    } else if (source.startsWith('/*', at)) {
      const close = source.indexOf('*/', at + 2);
      const stop = close === -1 ? source.length : close + 2;
      for (; at < stop; at++) if (source[at] === '\n') line++;
    } else if (ch === "'" || ch === '"') {
      at++;
      while (at < source.length && source[at] !== ch && source[at] !== '\n') {
        at += source[at] === '\\' ? 2 : 1;
      }
      at++;
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = at;
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at]!)) at++;
      tokens.push({ text: source.slice(start, at), offset: start, line });
    } else {
      tokens.push({ text: ch, offset: at, line });
      at++;
    }
  }
  return tokens;
}

/** Whether `tokens[index]` is a keyword rather than a field name such as `resource.data.match`. */
function isKeyword(tokens: readonly Token[], index: number): boolean {
  return tokens[index - 1]?.text !== '.';
}

/** Whether the `{` at `index` opens a path capture such as `/{id}` rather than a block. */
function opensCapture(source: string, tokens: readonly Token[], index: number): boolean {
  return source[tokens[index]!.offset - 1] === '/';
}

/**
 * Which statement a missing `;` belongs to: the nearest statement keyword
 * before the failure that no `;` has closed since. Reading tokens rather than
 * lines keeps a `let` whose next line opens with `return` attributed to the
 * `let`, and a ruleset written on a few long lines attributed to the allow
 * rather than to whichever keyword opens the line.
 */
function unterminatedStatement(tokens: readonly Token[]): string | undefined {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const text = tokens[index]!.text;
    if (text === ';') return undefined;
    const named = STATEMENTS[text];
    if (named !== undefined && isKeyword(tokens, index)) return named;
  }
  return undefined;
}

/** The block keyword a `{` at `index` belongs to, if one introduced it. */
function blockKeywordBefore(source: string, tokens: readonly Token[], index: number): string | undefined {
  for (let at = index - 1; at >= 0; at--) {
    const text = tokens[at]!.text;
    if (text === ';') return undefined;
    if ((text === '{' || text === '}') && !opensCapture(source, tokens, at) && !closesCapture(source, tokens, at)) {
      return undefined;
    }
    const named = BLOCKS[text];
    if (named !== undefined && isKeyword(tokens, at)) return named;
  }
  return undefined;
}

/** Whether the `}` at `index` closes a path capture opened by `/{`. */
function closesCapture(source: string, tokens: readonly Token[], index: number): boolean {
  if (tokens[index]!.text !== '}') return false;
  for (let at = index - 1; at >= 0; at--) {
    const text = tokens[at]!.text;
    if (text === '{') return opensCapture(source, tokens, at);
    if (text === '}' || text === ';') return false;
  }
  return false;
}

/** One `{` the source opened and has not yet closed. */
interface OpenBlock {
  construct: string;
  line: number;
}

/** The blocks open at the failure, outermost first. Path captures are skipped. */
function openBlocks(source: string, tokens: readonly Token[]): OpenBlock[] {
  const open: OpenBlock[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.text === '{' && !opensCapture(source, tokens, index)) {
      open.push({ construct: blockKeywordBefore(source, tokens, index) ?? MAP_LITERAL, line: token.line });
    } else if (token.text === '}' && !closesCapture(source, tokens, index)) {
      open.pop();
    }
  }
  return open;
}

/** Whether the parser named one terminal among the alternatives it expected. */
function expects(expected: string, terminal: string): boolean {
  return expected.includes(`"${terminal}"`);
}

/** How many alternatives one expectation set names. */
function alternativeCount(expected: string): number {
  const quoted = expected.match(/"[^"]*"/g);
  if (quoted === null) return 0;
  return quoted.length;
}

/** Whether the parser expected exactly one terminal, and that terminal is `terminal`. */
function expectsOnly(expected: string, terminal: string): boolean {
  return alternativeCount(expected) === 1 && expects(expected, terminal);
}

/**
 * What the source needs, in the reader's terms rather than the parser's.
 *
 * A missing terminator names the statement it belongs to, a missing `{` names
 * the block keyword that wanted it, and a missing `}` names the innermost block
 * still open and the line that opened it. A short set of alternatives is a
 * vocabulary and is kept as it is. A long one is the parser's state and is
 * dropped for the line and column.
 */
export function parseErrorWording(failure: ParseFailurePosition, source: string): string {
  const tokens = tokensBefore(source, offsetOf(source, failure.line, failure.column));
  if (expects(failure.expected, ';')) {
    const statement = unterminatedStatement(tokens);
    return statement === undefined ? `expected ';' ${UNNAMED_STATEMENT}` : `expected ';' after ${statement}`;
  }
  if (expectsOnly(failure.expected, '{')) {
    const block = blockKeywordBefore(source, tokens, tokens.length);
    if (block !== undefined) return `expected '{' to open ${block}`;
  }
  if (expectsOnly(failure.expected, '}')) {
    const innermost = openBlocks(source, tokens).at(-1);
    if (innermost !== undefined) return `expected '}' to close ${innermost.construct} opened at line ${innermost.line}`;
  }
  if (alternativeCount(failure.expected) <= READABLE_ALTERNATIVES) {
    return `expected ${failure.expected}`;
  }
  return 'syntax error';
}
