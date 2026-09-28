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
 * the parser's own. A stack overflow on a long run of prefix operators or a
 * chain of thousands of terms is a parse failure too.
 */
export function matchRtdbExpression(raw: string): RtdbExpressionMatch {
  const source = raw.trim();
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
