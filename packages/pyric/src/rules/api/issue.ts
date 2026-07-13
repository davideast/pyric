/**
 * The unified rules diagnostic — one shape for every issue a ruleset can
 * carry, whatever stage produced it.
 *
 * Before this, three separate shapes described the same idea: the linter's
 * `LintWarning`, the validator's `ValidationFinding`, and the parser's
 * `ParseError`. A caller that wanted "everything wrong with this source"
 * had to collect three arrays and reconcile three different field sets.
 * `RuleIssue` collapses them. The `origin` field records which stage found
 * the issue so a caller can still filter (`origin === 'parse'` for the
 * compile blockers) without three types.
 */

import type { ParseError } from '../grammar/FirestoreParser.js';
import type { LintWarning } from '../linter/linter.js';
import type { ValidationFinding } from '../grammar/FirestoreValidator.js';
import type { RtdbRulesFinding } from '../rtdb/constraints/document.js';

/** Ordered by decreasing urgency. `info` is advisory. */
export type RuleIssueSeverity = 'error' | 'warning' | 'info';

/**
 * The stage that produced the issue.
 *   - `parse`    — the source did not parse; nothing downstream ran.
 *   - `validate` — a structural/security finding on a parsed ruleset.
 *   - `lint`     — a budget/quality/hallucination warning.
 */
export type RuleIssueOrigin = 'parse' | 'validate' | 'lint';

export interface RuleIssue {
  /** Stable machine code, e.g. `'PARSE_ERROR'`, `'SEC-4'`, `'GET_BUDGET'`. */
  code: string;
  severity: RuleIssueSeverity;
  /** Human-readable description. */
  message: string;
  /** Rules path the issue applies to, when known (e.g. `'/users/{uid}'`). */
  path?: string;
  /** 1-indexed source line, when known. */
  line?: number;
  /** Suggested remediation, verbatim, when the producing stage offers one. */
  fix?: string;
  origin: RuleIssueOrigin;
}

export function parseErrorToIssue(error: ParseError): RuleIssue {
  const issue: RuleIssue = {
    code: 'PARSE_ERROR',
    severity: 'error',
    message: error.message,
    origin: 'parse',
  };
  if (error.line > 0) issue.line = error.line;
  return issue;
}

export function lintWarningToIssue(warning: LintWarning): RuleIssue {
  const issue: RuleIssue = {
    code: warning.rule,
    severity: warning.severity,
    message: warning.message,
    origin: 'lint',
  };
  if (warning.location?.matchPath) issue.path = warning.location.matchPath;
  if (warning.fix) issue.fix = warning.fix;
  return issue;
}

/** Validator severities are a four-level urgency scale; fold them onto the
 *  three-level `RuleIssue` scale (critical/high → error, medium → warning,
 *  low → info) so one list sorts sensibly. */
export function validationFindingToIssue(finding: ValidationFinding): RuleIssue {
  const severity: RuleIssueSeverity =
    finding.severity === 'critical' || finding.severity === 'high'
      ? 'error'
      : finding.severity === 'medium'
        ? 'warning'
        : 'info';
  return {
    code: finding.code,
    severity,
    message: finding.message,
    path: finding.path,
    origin: 'validate',
  };
}

/** Map an RTDB check finding (from the internal document `check()`) onto the
 *  unified issue. `severity` is decided by the caller (errors vs warnings
 *  live in separate arrays on the check result). */
export function rtdbFindingToIssue(
  finding: RtdbRulesFinding,
  severity: RuleIssueSeverity,
): RuleIssue {
  return {
    code: finding.code,
    severity,
    message: finding.message,
    path: finding.path,
    origin: 'validate',
  };
}
