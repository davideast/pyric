import * as ohm from 'ohm-js';
import { RTDB_EXPR_OHM_SOURCE } from './grammar/RtdbExpr.ohm.generated.js';

let cachedGrammar: ohm.Grammar | undefined;

/** Engine-internal diagnostic used to lock lazy rules-barrel initialization. */
export function isRtdbExpressionEngineInitialized(): boolean {
  return cachedGrammar !== undefined;
}

function getGrammar(): ohm.Grammar {
  cachedGrammar ??= ohm.grammar(RTDB_EXPR_OHM_SOURCE);
  return cachedGrammar;
}

/** Match expression text without exposing a grammar instance to callers. */
export function matchRtdbExpression(raw: string): ohm.MatchResult {
  return getGrammar().match(raw.trim());
}

/** Create semantics lazily against the shared grammar. Engine-internal only. */
export function createRtdbExpressionSemantics(): ohm.Semantics {
  return getGrammar().createSemantics();
}
