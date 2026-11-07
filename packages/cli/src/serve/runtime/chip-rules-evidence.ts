import { failedComparisons } from './rule-comparisons.js';
import type { ChipRequest } from './chip-traffic.js';

type Evidence = NonNullable<ChipRequest['rulesEvidence']>;
type Rule = Evidence['rules'][number];
type Check = Rule['checks'][number];
type Escape = (value: string) => string;

export function rulesSummary(request: ChipRequest): string {
  if (request.rules?.kind === 'bypassed') return 'Rules were bypassed for admin access.';
  const evidence = request.rulesEvidence;
  if (evidence?.decision === 'UNSUPPORTED') return 'Pyric could not determine the rules result for this request.';
  if (request.rules?.kind === 'not-evaluated') {
    if (request.rules.reason === 'unsupported') return 'Pyric does not yet support this rules check.';
    if (request.rules.reason === 'runtime-error') return 'An error prevented the rules from running.';
    return 'The rules were not checked for this request.';
  }
  if (request.evidenceExpired) return 'The saved checks for this request have expired.';
  if (!evidence) return 'The checks for this request are unavailable.';
  if (evidence.decision === 'ALLOW') return 'A rule allowed this request.';
  const proof = evidence.queryProof;
  if (proof?.kind === 'unsupported-path' || proof?.kind === 'unsupported-predicate') return 'Part of this query check is unsupported. The saved results do not explain the entire decision.';
  if (proof?.kind === 'constraints-not-satisfied') return 'The query could include documents the rules do not allow.';
  if (proof?.kind === 'no-rule') return 'There is no rule allowing this query.';
  if (evidence.rules.some(rule => rule.verdict === 'ERROR')) return 'No rule allowed the request, and a rule encountered an error.';
  if (evidence.scope === 'query-residual') return 'The query met the document constraints but failed the remaining access checks.';
  return 'No applicable rule allowed this request.';
}

function fact(label: string, value: string): string {
  return `<div class="request-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function record(content: string, className = ''): string {
  return `<div class="rules-record ${className}"><div class="rules-record-body">${content}</div></div>`;
}

function checkResult(check: Check): string {
  switch (check.state) {
    case 'skipped': return 'Not checked';
    case 'error': return check.error;
    case 'unavailable': return 'These details are not included in the saved record.';
    case 'value': return JSON.stringify(check.value);
  }
}

function condition(expression: string, escape: Escape): string {
  return fact('Condition', `<code class="rule-expression" tabindex="0" aria-label="Condition">${escape(expression)}</code>`);
}

function skippedContext(check: Check, checks: readonly Check[], escape: Escape): string {
  if (check.state !== 'skipped') return '';
  const parent = check.parent === null ? undefined : checks[check.parent];
  const earlier = checks.find(candidate => candidate.parent === check.parent);
  let reason: string;
  if (parent?.operator === '&&' && earlier?.state === 'value' && earlier.value === false) {
    reason = 'Every check must pass. This earlier check failed, so checking the rest could not make this condition pass.';
  } else if (parent?.operator === '||' && earlier?.state === 'value' && earlier.value === true) {
    reason = 'Only one check needs to pass. This earlier check passed, so no further checks were needed.';
  } else {
    return fact('Why', 'The saved record does not explain why this check was skipped.');
  }
  return fact('Why', reason) + fact('Earlier check', `<code class="rule-expression" tabindex="0" aria-label="Earlier check">${escape(earlier.expression)}</code>`);
}

function renderCheck(check: Check, checks: readonly Check[], escape: Escape): string {
  let resultLabel = 'Result';
  if (check.state === 'error') resultLabel = 'Error';
  let context = skippedContext(check, checks, escape);
  if (check.helper !== undefined) context += fact('Function', `<code>${escape(check.helper)}()</code>`);
  if (check.binding !== undefined) context += fact('Variable', `<code>${escape(check.binding)}</code>`);
  return record(`<dl class="rules-facts">${condition(check.expression, escape)}${fact(resultLabel, escape(checkResult(check)))}${context}</dl>`, 'rule-check');
}

function renderComparisons(rule: Rule, escape: Escape): string {
  const comparisons = failedComparisons(rule.checks);
  if (comparisons.length === 0) {
    // Older or incomplete captures still show the actual failed condition.
    if (rule.verdict === 'ALLOW') return '';
    let message = 'This condition returned false.';
    if (rule.verdict === 'ERROR') message = rule.error ?? 'This condition encountered an error.';
    if (rule.verdict === 'UNSUPPORTED') message = 'Pyric does not yet support this condition.';
    return record(`<dl class="rules-facts">${condition(rule.expression, escape)}${fact('Result', escape(message))}</dl>`);
  }
  return comparisons.map(comparison => {
    let source = '';
    if (comparison.expectedField !== null) source = `<span class="rules-value-source">${escape(comparison.expectedField)}</span>`;
    const expected = `<span class="rules-expected"><span>${escape(comparison.requirement)}</span><code>${escape(comparison.expected)}</code>${source}</span>`;
    return record(`<div class="rules-record-heading"><strong>${escape(comparison.field)}</strong><span class="rules-status">Failed</span></div><dl class="rules-facts">${fact('Actual', `<code>${escape(comparison.observed)}</code>`)}${fact('Check', expected)}</dl>`, 'rule-comparison');
  }).join('');
}

function renderRule(rule: Rule, lineLabel: string, escape: Escape): string {
  let location = 'Rule';
  if (rule.line !== undefined) location = `${lineLabel} ${rule.line}`;
  const result = {
    ALLOW: 'True. This rule allowed the request.',
    DENY: 'False. This rule did not allow the request.',
    ERROR: 'This rule encountered an error.',
    UNSUPPORTED: 'Pyric does not yet support this rule.',
  }[rule.verdict];
  let path = '';
  if (rule.path !== undefined) path = fact('Path', `<code>${escape(rule.path)}</code>`);
  const header = record(`<strong>${location}</strong><dl class="rules-facts">${condition(rule.expression, escape)}${fact('Result', result)}${path}</dl>`);
  // The rule condition is already shown above; literal rows only repeat its text.
  const checks = rule.checks.filter(check => check.expression !== rule.expression && check.kind !== 'literal');
  return `<div class="rows rules-group">${header}${checks.map(check => renderCheck(check, rule.checks, escape)).join('')}</div>`;
}

function renderPaths(evidence: Evidence, requestPath: string, escape: Escape): string {
  const records = evidence.paths.map(path => {
    let explanation = `This pattern does not cover ${requestPath}, so its rules do not apply here.`;
    if (path.matched) explanation = `This pattern covers ${requestPath}, so its access rules were considered.`;
    let location = '';
    if (path.line !== undefined) {
      const label = evidence.scope === 'query-residual' ? 'Residual line' : 'Line';
      location = fact('Location', `${label} ${path.line}`);
    }
    return record(`<code>${escape(path.path)}</code><dl class="rules-facts">${fact('Applies', escape(explanation))}${location}</dl>`);
  }).join('');
  if (records.length === 0) return '';
  return `<section class="rules-section"><strong class="section-title">Which rules apply</strong><div class="rows">${records}</div></section>`;
}

function renderProof(evidence: Evidence, escape: Escape): string {
  if (evidence.queryProof === undefined) return '';
  return evidence.queryProof.failures.map(failure => {
    const expression = failure.expression ?? 'Query constraint';
    let location = '';
    if (failure.line !== undefined) location = fact('Location', `Line ${failure.line}`);
    return record(`<code>${escape(expression)}</code><dl class="rules-facts">${fact('Reason', escape(failure.reason))}${location}</dl>`);
  }).join('');
}

/** Captured facts are primary; technical traces are a single secondary disclosure. */
export function rulesEvidenceHtml(request: ChipRequest, escape: Escape, chevron = ''): string {
  const evidence = request.rulesEvidence;
  if (!evidence) return '';
  let primary = '';
  const comparisons = evidence.rules.map(rule => renderComparisons(rule, escape)).join('');
  const proof = renderProof(evidence, escape);
  if (evidence.decision !== 'ALLOW' && comparisons + proof !== '') {
    primary = `<section class="rules-section"><strong class="section-title">Checks that failed</strong><div class="rows">${proof}${comparisons}</div></section>`;
  }
  let lineLabel = 'Line';
  let scope = '';
  if (evidence.scope === 'query-residual') {
    lineLabel = 'Residual line';
    scope = '<span class="hint">Residual lines belong to the generated query checks, not the deployed rules.</span>';
  }
  let truncation = '';
  if (evidence.truncated) truncation = '<span class="hint">This request exceeded the recording limit. Some checks or text are missing.</span>';
  const path = request.path ?? 'this request';
  const rules = evidence.rules.map(rule => renderRule(rule, lineLabel, escape)).join('');
  const body = `${scope}${renderPaths(evidence, path, escape)}
        <section class="rules-section"><strong class="section-title">Checks in execution order</strong>${rules}</section>`;
  return ruleDetailsDisclosure({ id: request.id, lead: primary + truncation, body, privacy: FIRESTORE_PRIVACY }, escape, chevron);
}

const FIRESTORE_PRIVACY = 'Full documents and complete sign-in records are not included here. The values shown can still be private. Review them before copying or sharing.';
const RTDB_PRIVACY = 'Full database records and email addresses are omitted from rule details.';
const STORAGE_PRIVACY = 'Object bytes and email addresses are omitted from rule details.';

/** The parts of one row's "Rule details" disclosure: what shows above it, what it holds, and its privacy note. */
interface Disclosure {
  id: string;
  lead?: string;
  body: string;
  privacy?: string;
}

/** A row's collapsed "Rule details" section, shared by every service's evidence. */
function ruleDetailsDisclosure(disclosure: Disclosure, escape: Escape, chevron: string): string {
  let privacy = '';
  if (disclosure.privacy !== undefined) privacy = `<dl class="rules-facts rules-privacy">${fact('Privacy', disclosure.privacy)}</dl>`;
  return `<section class="rules-evidence">${disclosure.lead ?? ''}
    <details class="rules-disclosure" data-rule-details="${escape(disclosure.id)}">
      <summary><span>Rule details</span><span class="rules-chevron">${chevron}</span></summary>
      <div class="rules-detail-body">${disclosure.body}
        ${privacy}
      </div>
    </details></section>`;
}

const GAP_LABELS = {
  'stored-document': 'the stored data in production',
  'write-data': 'the written payload',
  'claim-values': 'token claim values',
  query: 'the query parameters',
} as const;

function formatGapList(needs: readonly (keyof typeof GAP_LABELS)[]): string {
  const labels = needs.map(need => GAP_LABELS[need]);
  if (labels.length === 0) return 'more request context';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** The "Local rules" line of a live row with no Firestore trace: the local verdict, or the data it needed. */
export function localRulesSummary(request: ChipRequest): string {
  const local = request.local;
  if (!local) return rulesSummary(request);
  if (local.result === 'unevaluated') {
    return `Needs ${formatGapList(local.needs)} to evaluate against local rules.`;
  }
  if (local.result === 'allow') return 'Local rules allowed this request.';
  if (local.rtdb?.errorCode === 'NO_MATCHING_RULE') {
    return 'Local rules denied this request (no matching rule allowed it).';
  }
  return 'Local rules did not allow this request.';
}

type LocalVerdict = NonNullable<ChipRequest['local']>;
type RtdbDetail = NonNullable<LocalVerdict['rtdb']>;
type StorageDetail = NonNullable<LocalVerdict['storage']>;
type RtdbTraceEntry = NonNullable<RtdbDetail['rtdbTrace']>[number];

const RTDB_VERDICT_LABELS: Record<RtdbTraceEntry['verdict'], string> = {
  ALLOW: 'Allowed',
  DENY: 'Denied',
  UNSUPPORTED: 'Unsupported',
  ERROR: 'Error',
};

const RTDB_KIND_LABELS: Record<RtdbTraceEntry['kind'], string> = {
  read: '.read',
  write: '.write',
  validate: '.validate',
};

function renderRtdbBindings(bindings: Record<string, string> | undefined, escape: Escape): string {
  if (!bindings || Object.keys(bindings).length === 0) return '';
  const pairs = Object.entries(bindings).map(([k, v]) => `${k} = ${v}`).join(', ');
  return fact('Variables', `<code>${escape(pairs)}</code>`);
}

function renderRtdbTraceEntry(entry: RtdbTraceEntry, escape: Escape): string {
  let facts = fact('Path', `<code>${escape(entry.path)}</code>`)
    + condition(entry.conditionText, escape)
    + fact('Result', escape(RTDB_VERDICT_LABELS[entry.verdict]))
    + renderRtdbBindings(entry.pathVariableBindings, escape);
  if (entry.message) facts += fact('Note', escape(entry.message));
  return record(`<strong>${escape(RTDB_KIND_LABELS[entry.kind])}</strong><dl class="rules-facts">${facts}</dl>`);
}

/** A section of evaluated rules, or nothing for an empty list. */
function evaluatedRulesSection(rows: readonly string[]): string {
  if (rows.length === 0) return '';
  return `<section class="rules-section"><strong class="section-title">Evaluated rules</strong><div class="rows">${rows.join('')}</div></section>`;
}

/** A card of summary facts, or nothing when there are none. */
function factsCard(facts: string): string {
  if (facts === '') return '';
  return record(`<dl class="rules-facts">${facts}</dl>`);
}

function rtdbDetailBody(detail: RtdbDetail, escape: Escape): string {
  let summaryFacts = '';
  if (detail.matchedPath) summaryFacts += fact('Rule path', `<code>${escape(detail.matchedPath)}</code>`);
  if (detail.matchedRule) summaryFacts += fact('Rule', `<code class="rule-expression" tabindex="0" aria-label="Condition">${escape(detail.matchedRule)}</code>`);
  summaryFacts += renderRtdbBindings(detail.pathVariableBindings, escape);
  if (detail.reason) summaryFacts += fact('Engine', escape(detail.reason));
  else if (detail.errorCode) summaryFacts += fact('Code', escape(detail.errorCode));
  const trace = (detail.rtdbTrace ?? []).map(entry => renderRtdbTraceEntry(entry, escape));
  return factsCard(summaryFacts) + evaluatedRulesSection(trace);
}

function storageDetailBody(detail: StorageDetail, escape: Escape): string {
  let summaryFacts = '';
  if (detail.matchedPath) summaryFacts += fact('Match', `<code>${escape(detail.matchedPath)}</code>`);
  if (detail.matchedLine !== undefined) summaryFacts += fact('Location', `Line ${detail.matchedLine}`);
  const reasons = (detail.reasons ?? []).map(reason => factsCard(fact('Check', escape(reason))));
  return factsCard(summaryFacts) + evaluatedRulesSection(reasons);
}

function ruleDetailBody(rule: LocalVerdict['rule'], escape: Escape): string {
  if (!rule) return '';
  let facts = '';
  if (rule.path) facts += fact('Match', `<code>${escape(rule.path)}</code>`);
  if (rule.line !== undefined) facts += fact('Location', `Line ${rule.line}`);
  if (rule.expression) facts += condition(rule.expression, escape);
  return factsCard(facts);
}

/** The "Rule details" of a live row's local verdict that carries no Firestore trace: its RTDB or Storage detail, else its rule. */
export function localRulesEvidenceHtml(request: ChipRequest, escape: Escape, chevron = ''): string {
  const local = request.local;
  if (!local) return '';
  let body = ruleDetailBody(local.rule, escape);
  let privacy: string | undefined;
  if (local.rtdb) {
    body = rtdbDetailBody(local.rtdb, escape);
    privacy = RTDB_PRIVACY;
  } else if (local.storage) {
    body = storageDetailBody(local.storage, escape);
    privacy = STORAGE_PRIVACY;
  }
  if (body === '') return '';
  return ruleDetailsDisclosure({ id: request.id, body, privacy }, escape, chevron);
}
