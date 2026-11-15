/**
 * Denial diagnostics projection for canonical operation and listener records.
 *
 * Extracts the deciding rule, human-readable reasons, and evidence-expiry flag
 * from evaluated denials (and fail-closed no-rules denials) without widening
 * `RulesDisposition` or mutating live history events.
 */
import type { RequestEvent, RulesDisposition, SandboxEvent } from './types/events.js';

/** Deciding security rule identified for a denied operation, when available. */
export interface OperationDenialRule {
  /** Rules match path (e.g. `/items/{id}` in Firestore or `/items/$id` in RTDB). */
  readonly path?: string;
  /** File/line/column citation (e.g. `firestore.rules:5:7`). */
  readonly citation?: string;
  /** 1-based source line of the deciding rule, when known. */
  readonly line?: number;
  /** 1-based source column of the deciding rule, when known. */
  readonly column?: number;
  /** Deciding rule expression or condition text. */
  readonly expression?: string;
}

/**
 * Why an operation or listener was denied by Security Rules. Present on
 * `OperationRecord` whenever rules evaluated to `deny` (or Storage denied
 * without rules configured), omitted on allowed or non-rules operations.
 */
export interface OperationDenial {
  /** Human-readable denial reasons in evaluation order. Always non-empty. */
  readonly reasons: readonly string[];
  /** Deciding rule that produced the denial, when recorded by the rules engine. */
  readonly rule?: OperationDenialRule;
  /** True when Firestore rules evidence has expired from the retention window. */
  readonly evidenceExpired?: true;
}

type MutableDenialRule = {
  -readonly [Key in keyof OperationDenialRule]: OperationDenialRule[Key];
};

type EvidenceRuleEntry = NonNullable<RequestEvent['rulesEvidence']>['rules'][number];

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}

function nonEmptyStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const entry of values) {
    const text = nonEmptyString(entry);
    if (text !== undefined) {
      out.push(text);
    }
  }
  return out;
}

function isDenyingEvidenceRule(entry: EvidenceRuleEntry): boolean {
  return entry.verdict === 'DENY' || entry.verdict === 'ERROR';
}

function selectEvidenceRule(event: RequestEvent): EvidenceRuleEntry | undefined {
  const rules = event.rulesEvidence?.rules;
  if (!rules || rules.length === 0) return undefined;
  const evaluated = event.evaluatedRule;
  if (evaluated !== undefined) {
    const byLine = rules.find(
      (entry) =>
        isDenyingEvidenceRule(entry) &&
        evaluated.line !== undefined &&
        entry.line === evaluated.line,
    );
    if (byLine !== undefined) return byLine;
    const byExpr = rules.find(
      (entry) =>
        isDenyingEvidenceRule(entry) &&
        evaluated.expression !== undefined &&
        entry.expression === evaluated.expression,
    );
    if (byExpr !== undefined) return byExpr;
  }
  return rules.find(isDenyingEvidenceRule);
}

interface RuleLocationSource {
  readonly citation?: string;
  readonly line?: number;
  readonly column?: number;
  readonly col?: number;
  readonly expression?: string;
}

function copyRuleLocation(target: MutableDenialRule, source: RuleLocationSource): void {
  const citation = nonEmptyString(source.citation);
  if (target.citation === undefined && citation !== undefined) {
    target.citation = citation;
  }
  if (target.line === undefined && typeof source.line === 'number') {
    target.line = source.line;
  }
  if (target.column === undefined) {
    if (typeof source.column === 'number') {
      target.column = source.column;
    } else if (typeof source.col === 'number') {
      target.column = source.col;
    }
  }
  const expression = nonEmptyString(source.expression);
  if (target.expression === undefined && expression !== undefined) {
    target.expression = expression;
  }
}

function copyQueryProofRule(target: MutableDenialRule, event: RequestEvent): void {
  const failures = event.queryProof?.failures;
  if (failures !== undefined && failures.length > 0) {
    let primary = failures.find((failure) => failure.kind !== 'constraints-not-satisfied');
    if (primary === undefined) {
      primary = failures[0];
    }
    if (primary?.rule !== undefined) {
      copyRuleLocation(target, primary.rule);
    }
  }
  if (Object.keys(target).length > 0) return;

  const evidenceFailure = event.rulesEvidence?.queryProof?.failures?.[0];
  if (evidenceFailure !== undefined) {
    copyRuleLocation(target, evidenceFailure);
  }
}

function extractRequestDenialRule(event: RequestEvent): OperationDenialRule | undefined {
  const rule: MutableDenialRule = {};
  copyQueryProofRule(rule, event);
  if (Object.keys(rule).length > 0) {
    return Object.freeze(rule);
  }
  if (event.evaluatedRule !== undefined) {
    copyRuleLocation(rule, event.evaluatedRule);
  }
  const evidenceRule = selectEvidenceRule(event);
  if (evidenceRule !== undefined) {
    const path = nonEmptyString(evidenceRule.path);
    if (rule.path === undefined && path !== undefined) {
      rule.path = path;
    }
    copyRuleLocation(rule, evidenceRule);
  }
  if (Object.keys(rule).length === 0) return undefined;
  return Object.freeze(rule);
}

function extractDenialRule(event: SandboxEvent): OperationDenialRule | undefined {
  if (event.kind === 'request') {
    return extractRequestDenialRule(event);
  }
  if (event.kind === 'operation' || event.kind === 'listener') {
    const rules = event.rules;
    if (!rules) return undefined;
    const rule: MutableDenialRule = {};
    const matchedPath = nonEmptyString(rules.matchedPath);
    if (matchedPath !== undefined) rule.path = matchedPath;
    const matchedRule = nonEmptyString(rules.matchedRule);
    if (matchedRule !== undefined) rule.expression = matchedRule;
    if (Object.keys(rule).length === 0) return undefined;
    return Object.freeze(rule);
  }
  return undefined;
}

function extractDenialReasons(event: SandboxEvent): string[] {
  if ('reasons' in event) {
    const direct = nonEmptyStrings(event.reasons);
    if (direct.length > 0) return direct;
  }
  if ('error' in event && event.error !== null && event.error !== undefined && typeof event.error === 'object') {
    const errorObj = event.error;
    if ('reasons' in errorObj) {
      const fromErrorReasons = nonEmptyStrings(errorObj.reasons);
      if (fromErrorReasons.length > 0) return fromErrorReasons;
    }
  }
  if ('rules' in event && event.rules !== undefined) {
    const ruleReason = nonEmptyString(event.rules.reason);
    if (ruleReason !== undefined) return [ruleReason];
  }
  if ('error' in event && event.error !== null && event.error !== undefined && typeof event.error === 'object') {
    const message = nonEmptyString(event.error.message);
    if (message !== undefined) return [message];
  }
  return [];
}

/** Build the frozen denial block for an operation or listener record, or `undefined`. */
export function denialFor(
  event: SandboxEvent,
  rules: RulesDisposition,
  result: string | undefined,
): OperationDenial | undefined {
  const isEvaluatedDeny = rules.kind === 'evaluated' && rules.verdict === 'deny';
  const isNoRulesDeny =
    result === 'deny' && rules.kind === 'not-evaluated' && rules.reason === 'no-rules';
  if (!isEvaluatedDeny && !isNoRulesDeny) return undefined;

  const evidenceExpired = event.kind === 'request' && event.rulesEvidenceExpired === true;
  let reasons = extractDenialReasons(event);
  if (reasons.length === 0) {
    if (evidenceExpired) {
      reasons = ['Firestore rules evidence expired.'];
    } else if (isNoRulesDeny) {
      reasons = ['No security rules configured; default deny.'];
    } else {
      reasons = ['Denied by security rules.'];
    }
  }
  const rule = extractDenialRule(event);
  const denial: {
    reasons: readonly string[];
    rule?: OperationDenialRule;
    evidenceExpired?: true;
  } = {
    reasons: Object.freeze([...reasons]),
  };
  if (rule !== undefined) denial.rule = rule;
  if (evidenceExpired) denial.evidenceExpired = true;
  return Object.freeze(denial);
}
