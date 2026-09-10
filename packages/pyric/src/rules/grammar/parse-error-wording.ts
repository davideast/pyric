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
 * So the set is read for the one terminal that decides the edit, and the line
 * it failed on says which construct the edit belongs to. Where neither is
 * decidable the wording says `syntax error` and lets the line and column carry
 * the whole message, which is still more than a list of nineteen alternatives.
 */

/** One parse failure, as the grammar reports it. */
export interface ParseFailurePosition {
  line: number;
  column: number;
  expected: string;
}

/** The keywords a rules source opens a statement with, and what each one is. */
const CONSTRUCTS: Readonly<Record<string, string>> = {
  allow: 'after the allow statement',
  let: 'after the let binding',
  return: 'after the return expression',
  rules_version: 'after the version line',
};

/** How a missing terminator is worded when the line names no construct. */
const UNNAMED_CONSTRUCT = 'at the end of the statement';

/** How far back an unterminated statement is looked for from the failure point. */
const STATEMENT_LOOKBACK = 4;

/** What one source line opens with, lower-cased, or the empty string. */
function openingWord(line: string | undefined): string {
  if (line === undefined) return '';
  const word = line.trim().split(/[^A-Za-z_]+/)[0];
  return (word ?? '').toLowerCase();
}

/**
 * Which construct an unterminated statement belongs to.
 *
 * A missing terminator is reported at the token that followed it, which is
 * usually the closing brace on the next line, so the failing line is read
 * first and then the few lines above it, and the nearest one that opens a
 * statement is the one that was never terminated.
 */
function unterminatedConstruct(source: string, line: number): string {
  const lines = source.split('\n');
  const earliest = Math.max(1, line - STATEMENT_LOOKBACK);
  for (let at = line; at >= earliest; at--) {
    const named = CONSTRUCTS[openingWord(lines[at - 1])];
    if (named !== undefined) return named;
  }
  return UNNAMED_CONSTRUCT;
}

/** Whether the parser named one terminal among the alternatives it expected. */
function expects(expected: string, terminal: string): boolean {
  return expected.includes(`"${terminal}"`);
}

/**
 * How many alternatives a reader can still act on. A set this size is a
 * vocabulary, such as the allow verbs a match block takes, and reading it is
 * the fastest way to the edit. Past it the set is the parser's state.
 */
const READABLE_ALTERNATIVES = 8;

/** How many alternatives one expectation set names. */
function alternativeCount(expected: string): number {
  const quoted = expected.match(/"[^"]*"/g);
  if (quoted === null) return 0;
  return quoted.length;
}

/**
 * What the source needs, in the reader's terms rather than the parser's.
 *
 * A missing terminator is decided from the failing line, so the wording says
 * which statement is unterminated rather than only which character is absent.
 * A short set of alternatives is a vocabulary and is kept as it is. A long one
 * is the parser's state and is dropped for the line and column.
 */
export function parseErrorWording(failure: ParseFailurePosition, source: string): string {
  if (expects(failure.expected, ';')) {
    return `expected ';' ${unterminatedConstruct(source, failure.line)}`;
  }
  if (alternativeCount(failure.expected) <= READABLE_ALTERNATIVES) {
    return `expected ${failure.expected}`;
  }
  return 'syntax error';
}
