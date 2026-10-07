import { compileRtdbRules } from './compiled-rules.js';
import { checkRtdbRules, type RtdbRulesFinding } from './constraints/document.js';

/**
 * Why a Realtime Database ruleset would not load: it is not a rules document
 * (`parse`), or a rule in it carries an error finding (`compile`). Every
 * rules load path refuses such a ruleset and keeps the rules in force.
 */
export interface RtdbRulesSourceRejection {
  kind: 'parse' | 'compile';
  /** The reason, naming each rejected rule's path and kind. */
  message: string;
  /** The error findings behind a `compile` rejection; empty for `parse`. */
  findings: RtdbRulesFinding[];
}

function locate(finding: RtdbRulesFinding): string {
  if (finding.rule === 'ruleset') return finding.path;
  return finding.path === '/' ? `/${finding.rule}` : `${finding.path}/${finding.rule}`;
}

function isRulesDocument(value: unknown): value is { rules: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rules = (value as { rules?: unknown }).rules;
  return typeof rules === 'object' && rules !== null && !Array.isArray(rules);
}

/**
 * The reason production's deploy would refuse a parsed `{ rules }` document,
 * or `null` when it would load. Only error findings reject; a structural
 * check that has no captured deploy rejection reports as a warning and does
 * not.
 */
export function rtdbRulesSourceRejection(rules: unknown): RtdbRulesSourceRejection | null {
  if (!isRulesDocument(rules)) {
    return {
      kind: 'parse',
      message: "Realtime Database rules must be a JSON object with a top-level 'rules' object.",
      findings: [],
    };
  }
  const { errors } = checkRtdbRules(() => compileRtdbRules(rules));
  if (errors.length === 0) return null;
  const reasons = errors.map((finding) => `${locate(finding)}: ${finding.message}`);
  return {
    kind: 'compile',
    message: `Realtime Database rules did not compile. ${reasons.join(' ')}`,
    findings: errors,
  };
}
