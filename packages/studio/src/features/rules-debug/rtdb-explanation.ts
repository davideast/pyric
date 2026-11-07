/**
 * The Realtime Database half of a rules explanation: which rule phase a
 * verdict ran, where its deciding rule sits in `database.rules.json`, and the
 * headline, rule node and `$variable` bindings for an allowed or denied op.
 */
import { locateRtdbRule } from 'pyric/rules/internal/rtdb';
import type { Denial, RuleExplanation, RulePhase } from './model.js';

function isRtdbValidateReason(reason: string | undefined): boolean {
  return reason === 'Validation rule evaluated to false' || Boolean(reason?.startsWith("Validation rule at '"));
}

/** RTDB rule phase for a denial: a `.validate` failure (from the mechanical
 *  `reason`) beats the method-derived read/write gate. */
function rtdbPhase(denial: Denial): RulePhase {
  if (isRtdbValidateReason(denial.rules?.reason)) return 'validate';
  const m = denial.method;
  return m === 'get' || m === 'list' || m === 'listen' ? 'read' : 'write';
}

/** 1-based line in `database.rules.json` of the RTDB rule that decided a
 *  denial: the `.read`, `.write` or `.validate` key at the verdict's
 *  `matchedPath`. Undefined for an implicit deny, for a verdict without a
 *  matched path, or when the source is absent or does not contain the rule. */
export function rtdbRuleLine(denial: Denial, rulesSource: string | undefined): number | undefined {
  const matchedPath = denial.rules?.matchedPath;
  if (!rulesSource || !matchedPath || denial.rules?.errorCode === 'NO_MATCHING_RULE') {
    return undefined;
  }
  return locateRtdbRule(rulesSource, matchedPath, `.${rtdbPhase(denial)}`)?.line;
}

/** RTDB allow: the `.read`/`.write` node at `matchedPath` that granted access, its expression and bindings. */
export function explainRtdbAllow(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const phase = rtdbPhase(denial);
  const matchedPath = denial.rules?.matchedPath;
  const matchedRule = denial.rules?.matchedRule;
  const bindings = denial.rules?.pathVariableBindings;
  let headline = `Rules allowed ${denial.method} on ${denial.path}.`;
  if (matchedPath) {
    headline = `The \`.${phase}\` rule at \`${matchedPath}\` allowed ${denial.method} on ${denial.path}.`;
  }
  const explanation: RuleExplanation = {
    headline,
    engine: 'rtdb',
    phase,
    ruleLines,
    otherLines,
    implicitDeny: false,
  };
  if (matchedPath) explanation.ruleNode = `${matchedPath} .${phase}`;
  if (matchedRule) explanation.ruleExpression = matchedRule;
  if (bindings !== undefined && Object.keys(bindings).length > 0) explanation.bindings = bindings;
  return explanation;
}

/** RTDB: grounded in `SimulateHandler`'s verdict — the `.write`/`.validate` node
 *  at `matchedPath`, its raw expression, and the path-variable bindings. */
export function explainRtdb(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const rules = denial.rules;
  const phase = rtdbPhase(denial);
  const implicitDeny = !rules?.matchedPath || rules?.errorCode === 'NO_MATCHING_RULE';
  const bindings =
    rules?.pathVariableBindings && Object.keys(rules.pathVariableBindings).length > 0
      ? rules.pathVariableBindings
      : undefined;

  let headline: string;
  let ruleNode: string | undefined;
  if (implicitDeny) {
    headline = `No \`.${phase}\` rule granted ${denial.method} on ${denial.path}: RTDB implicit deny (no rule matched).`;
  } else if (phase === 'validate') {
    ruleNode = `${rules!.matchedPath} .validate`;
    headline = `The \`.validate\` rule at \`${rules!.matchedPath}\` rejected the proposed value for ${denial.method} ${denial.path}.`;
  } else {
    ruleNode = `${rules!.matchedPath} .${phase}`;
    headline = `The \`.${phase}\` rule at \`${rules!.matchedPath}\` evaluated false for ${denial.method} ${denial.path}.`;
  }

  return {
    headline,
    engine: 'rtdb',
    ruleNode,
    ruleExpression: rules?.matchedRule,
    phase,
    bindings,
    ruleLines,
    otherLines,
    implicitDeny,
  };
}
