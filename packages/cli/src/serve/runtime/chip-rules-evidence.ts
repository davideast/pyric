import type { ChipRequest } from './chip-traffic.js';

type Evidence = NonNullable<ChipRequest['rulesEvidence']>;
type Rule = Evidence['rules'][number];
type Check = Rule['checks'][number];
type Escape = (value: string) => string;

export function rulesSummary(request: ChipRequest): string {
  if (request.rules?.kind === 'bypassed') return 'Rules bypassed by admin access.';
  const evidence = request.rulesEvidence;
  if (evidence?.decision === 'UNSUPPORTED') return 'The evaluator could not determine an outcome.';
  if (request.rules?.kind === 'not-evaluated') {
    if (request.rules.reason === 'unsupported') return 'This rules evaluation is unsupported.';
    if (request.rules.reason === 'runtime-error') return 'An error prevented rules evaluation.';
    return 'Rules were not evaluated.';
  }
  if (request.evidenceExpired) return 'Evaluation evidence expired for this request.';
  if (!evidence) return 'Evaluation evidence unavailable for this request.';
  if (evidence.decision === 'ALLOW') return 'A matching rule allowed this request.';
  const proof = evidence.queryProof;
  if (proof?.kind === 'unsupported-path' || proof?.kind === 'unsupported-predicate') return 'The local query proof is unsupported. Any residual checks are only partial evidence.';
  if (proof?.kind === 'constraints-not-satisfied') return 'Query constraints did not satisfy the rules.';
  if (proof?.kind === 'no-rule') return 'No matching list rule.';
  if (evidence.rules.some(rule => rule.verdict === 'ERROR')) return 'No rule granted access. An evaluation error occurred.';
  if (evidence.scope === 'query-residual') return 'The query passed the constraint proof, but its remaining conditions did not grant access.';
  return 'No matching rule granted access.';
}

function checkResult(check: Check): string {
  switch (check.state) {
    case 'skipped': return 'Not evaluated (short-circuited)';
    case 'error': return `Error: ${check.error}`;
    case 'unavailable': return 'Value not retained';
    case 'value': return JSON.stringify(check.value);
  }
}

function failedCheck(check: Check): boolean {
  if (check.state === 'error') return true;
  return check.state === 'value' && check.value === false;
}

/** Include observed operands below a failed condition, not just its false result. */
function decidingIndices(checks: readonly Check[]): Set<number> {
  const selected = new Set<number>();
  for (const [index, check] of checks.entries()) {
    if (failedCheck(check)) selected.add(index);
    if (check.parent !== null && selected.has(check.parent)) selected.add(index);
  }
  return selected;
}

function checkDepth(index: number, checks: readonly Check[]): number {
  let parent = checks[index]?.parent;
  let depth = 0;
  while (parent !== null && parent !== undefined && parent < index && depth < 6) {
    depth++;
    index = parent;
    parent = checks[index]?.parent;
  }
  return depth;
}

function renderCheck(check: Check, depth: number, escape: Escape): string {
  let context = '';
  if (check.helper !== undefined) context += `<small>Helper: ${escape(check.helper)}</small>`;
  if (check.binding !== undefined) context += `<small>Binding: ${escape(check.binding)}</small>`;
  return `<div class="rule-check" style="--rule-depth:${depth * 8}px"><code>${escape(check.expression)}</code><span>${escape(checkResult(check))}</span>${context}</div>`;
}

function renderRule(rule: Rule, full: boolean, lineLabel: string, escape: Escape): string {
  const selected = decidingIndices(rule.checks);
  const checks: string[] = [];
  for (const [index, check] of rule.checks.entries()) {
    if (!full) {
      if (!selected.has(index)) continue;
      if (check.state === 'unavailable' || check.state === 'skipped') continue;
      if (check.expression === rule.expression) continue;
    }
    checks.push(renderCheck(check, checkDepth(index, rule.checks), escape));
  }
  let location = 'Rule';
  if (rule.line !== undefined) location = `${lineLabel} ${rule.line}`;
  const verdict = { ALLOW: 'true', DENY: 'false', ERROR: 'Error', UNSUPPORTED: 'Unsupported' }[rule.verdict];
  let context = '';
  if (rule.path !== undefined) context += `<code>${escape(rule.path)}</code>`;
  if (rule.error !== undefined) context += `<span>${escape(rule.error)}</span>`;
  return `<section class="rule-evaluation"><div class="history-summary"><span>${location}</span><strong>${verdict}</strong></div><code>${escape(rule.expression)}</code>${context}${checks.join('')}</section>`;
}

function renderProof(evidence: Evidence, escape: Escape): string {
  if (evidence.queryProof === undefined) return '';
  return evidence.queryProof.failures.map(failure => {
    const expression = failure.expression ?? 'Query constraint';
    let location = '';
    if (failure.line !== undefined) location = `<small>Line ${failure.line}</small>`;
    return `<div class="rule-check"><code>${escape(expression)}</code><span>${escape(failure.reason)}</span>${location}</div>`;
  }).join('');
}

function renderPaths(evidence: Evidence, escape: Escape): string {
  return evidence.paths.map(path => {
    const matched = path.matched ? 'Matched' : 'Did not match';
    let location = '';
    if (path.line !== undefined) {
      const label = evidence.scope === 'query-residual' ? 'residual line' : 'line';
      location = ` · ${label} ${path.line}`;
    }
    return `<div class="rule-check"><code>${escape(path.path)}</code><span>${matched}${location}</span></div>`;
  }).join('');
}

/** The request owns this snapshot, so opening details never evaluates rules again. */
export function rulesEvidenceHtml(request: ChipRequest, escape: Escape): string {
  const summary = `<strong>${escape(rulesSummary(request))}</strong>`;
  const evidence = request.rulesEvidence;
  if (!evidence) return `<section class="rules-evidence">${summary}</section>`;
  let lineLabel = 'Line';
  if (evidence.scope === 'query-residual') lineLabel = 'Residual line';
  let deciding = evidence.rules.map(rule => renderRule(rule, false, lineLabel, escape)).join('');
  if (deciding.length === 0) deciding = 'No allow condition was evaluated.';
  const full = evidence.rules.map(rule => renderRule(rule, true, lineLabel, escape)).join('');
  let scope = '';
  if (evidence.scope === 'query-residual') scope = '<span>Expression results cover the query residual; query-proof checks are shown separately. Residual line numbers refer to generated evaluation source, not the deployed rules.</span>';
  let truncation = '';
  if (evidence.truncated) truncation = '<span>Evidence truncated at the retention limit; some expressions or rules are omitted.</span>';
  return `<section class="rules-evidence">${summary}${renderProof(evidence, escape)}
    <details><summary>Deciding checks</summary><div class="rule-evaluations">${deciding}</div></details>
    <details><summary>Full evaluation</summary><div class="rule-evaluations">
      <span>Captured rules version: ${escape(evidence.version)}</span>${scope}${renderPaths(evidence, escape)}${full}
      <span>Only scalar values are retained; document and token objects are omitted.</span>
    </div></details>${truncation}</section>`;
}
