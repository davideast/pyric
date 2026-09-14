import type { TestResult } from 'pyric/rules/internal';
import type { RuleCheck, RulesEvidence } from '../../sandbox/types/rules-evidence.js';
import type { QueryProofDiagnostic } from '../../sandbox/types/query-proof.js';

type Evaluation = TestResult['trace'][number];
type ExpressionEntry = NonNullable<Evaluation['expressionTrace']>[number];

/** One budget per snapshot, shared across all rule and helper expressions. */
class EvidenceBudget {
  truncated = false;
  remainingChecks = 128;

  text(value: string): string {
    if (value.length <= 256) return value;
    this.truncated = true;
    return `${value.slice(0, 256)}…`;
  }

  take<T>(values: readonly T[], limit: number): T[] {
    if (values.length > limit) this.truncated = true;
    return values.slice(0, limit);
  }
}

function captureCheck(entry: ExpressionEntry, budget: EvidenceBudget): RuleCheck {
  const location = {
    expression: budget.text(entry.source), parent: entry.parent,
    helper: entry.inlinedFrom?.name,
    binding: entry.letBinding?.name,
  };
  if (location.helper !== undefined) location.helper = budget.text(location.helper);
  if (location.binding !== undefined) location.binding = budget.text(location.binding);
  if (entry.skipped) return { ...location, state: 'skipped' };
  if (entry.error !== undefined) return { ...location, state: 'error', error: budget.text(entry.error) };
  const value = entry.value;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return { ...location, state: 'value', value };
  }
  if (typeof value === 'string') return { ...location, state: 'value', value: budget.text(value) };
  // Never retain document objects, token maps, or arbitrary runtime handles.
  return { ...location, state: 'unavailable' };
}

function captureRule(rule: Evaluation, budget: EvidenceBudget): RulesEvidence['rules'][number] {
  const entries = rule.expressionTrace ?? [];
  const retained = budget.take(entries, budget.remainingChecks);
  budget.remainingChecks -= retained.length;
  const expression = rule.conditionText ?? '';
  const captured: RulesEvidence['rules'][number] = {
    expression: budget.text(expression), verdict: rule.verdict,
    checks: retained.map(entry => captureCheck(entry, budget)),
  };
  if (rule.line !== undefined) captured.line = rule.line;
  if (rule.matchPath !== undefined) captured.path = budget.text(rule.matchPath);
  if (rule.message !== undefined) captured.error = budget.text(rule.message);
  return captured;
}

export function captureRulesEvidence(
  result: TestResult,
  version: string,
  scope: RulesEvidence['scope'] = 'request',
): RulesEvidence {
  const budget = new EvidenceBudget();
  const rules = budget.take(result.trace, 32).map(rule => captureRule(rule, budget));
  const attempts = result.pathResolution?.attempts ?? [];
  const paths = budget.take(attempts, 32).map(entry => ({
    path: budget.text(entry.blockPath), matched: entry.matched, line: entry.line,
  }));
  return { version, scope, decision: result.decision, rules, paths, truncated: budget.truncated };
}

/** Query proof may reject a request before any residual simulation occurs. */
export function captureQueryEvidence(
  proof: QueryProofDiagnostic,
  version: string,
  residual?: RulesEvidence,
): RulesEvidence {
  const budget = new EvidenceBudget();
  const failures = budget.take(proof.failures, 32).map(failure => {
    const captured: NonNullable<RulesEvidence['queryProof']>['failures'][number] = {
      reason: budget.text(failure.reason),
    };
    if (failure.rule?.expression !== undefined) captured.expression = budget.text(failure.rule.expression);
    if (failure.rule?.line !== undefined) captured.line = failure.rule.line;
    return captured;
  });
  let decision: RulesEvidence['decision'] = 'DENY';
  if (proof.kind === 'unsupported-path' || proof.kind === 'unsupported-predicate') decision = 'UNSUPPORTED';
  const initial: RulesEvidence = { version, scope: 'query-residual', decision, truncated: false, rules: [], paths: [] };
  const evidence = residual ?? initial;
  return { ...evidence, queryProof: { kind: proof.kind, failures }, truncated: evidence.truncated || budget.truncated };
}
