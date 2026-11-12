import * as ohm from 'ohm-js';
import { RTDB_EXPR_OHM_SOURCE } from './grammar/RtdbExpr.ohm.generated.js';
import { MAX_BRACKET_DEPTH, scanBrackets } from '../grammar/bracket-scan.js';

let cachedGrammar: ohm.Grammar | undefined;

/** Engine-internal diagnostic used to lock lazy rules-barrel initialization. */
export function isRtdbExpressionEngineInitialized(): boolean {
  return cachedGrammar !== undefined;
}

function getGrammar(): ohm.Grammar {
  cachedGrammar ??= ohm.grammar(RTDB_EXPR_OHM_SOURCE);
  return cachedGrammar;
}

/** The parse failure for an expression whose match or AST passes exhaust the host stack. */
export const CHAINED_TERMS_MESSAGE = 'The expression chains more terms than the rules parser reads.';

/**
 * The longest expression text, in characters, the rules parser reads. Each
 * match of an expression costs memory in proportion to its length, about
 * 2 KB per character, and a lint matches each rule several times, so an
 * expression of megabytes exhausts the heap. 128 Ki characters holds a
 * 2,000-term `||` chain (about 44,000 characters), which production deploys
 * (r51), several times over. Production's own limit is not captured: r29
 * deploys a rules file over 256 KB. The bound is this parser's.
 */
export const MAX_EXPRESSION_LENGTH = 128 * 1024;

/** The parse failure for an expression longer than {@link MAX_EXPRESSION_LENGTH}. */
export function expressionTooLongMessage(length: number): string {
  return `The expression is ${length} characters long: the rules parser reads at most ${MAX_EXPRESSION_LENGTH}, a limit of this parser, not of production.`;
}

/** A matched expression, or why the expression does not parse. */
export type RtdbExpressionMatch =
  | { ok: true; match: ohm.MatchResult }
  | { ok: false; message: string };

/**
 * Match expression text without exposing a grammar instance to callers.
 *
 * The grammar descends once per nested bracket and exhausts the host stack
 * around 300 nested parentheses, so an expression nesting brackets more than
 * {@link MAX_BRACKET_DEPTH} levels deep is a parse failure before it is
 * matched. Production documents no nesting limit for RTDB rules; the bound is
 * the parser's own. An expression longer than {@link MAX_EXPRESSION_LENGTH}
 * is a parse failure before it is matched, so its cost stays bounded. `||`
 * and `&&` chains match flat and are read at any length up to that bound. A
 * stack overflow on a long run of prefix operators, or on a long chain of
 * another binary operator, is a parse failure too.
 */
export function matchRtdbExpression(raw: string): RtdbExpressionMatch {
  const source = raw.trim();
  if (source.length > MAX_EXPRESSION_LENGTH) return { ok: false, message: expressionTooLongMessage(source.length) };
  const tooDeep = scanBrackets(source, { comments: false, regexLiterals: true, multilineStrings: true })
    .find((span) => span.depth > MAX_BRACKET_DEPTH);
  if (tooDeep !== undefined) {
    return {
      ok: false,
      message: `Brackets nest more than ${MAX_BRACKET_DEPTH} levels deep at offset ${tooDeep.open}: the rules parser reads at most ${MAX_BRACKET_DEPTH}, a limit of this parser, not of production.`,
    };
  }
  try {
    const match = getGrammar().match(source);
    if (match.failed()) return { ok: false, message: match.message ?? 'Parse failed' };
    return { ok: true, match };
  } catch (e) {
    if (e instanceof RangeError) {
      return { ok: false, message: CHAINED_TERMS_MESSAGE };
    }
    throw e;
  }
}

/** Create semantics lazily against the shared grammar. Engine-internal only. */
export function createRtdbExpressionSemantics(): ohm.Semantics {
  return getGrammar().createSemantics();
}
