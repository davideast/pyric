/**
 * The tolerant lint front door — the entry point an AI author reaches for
 * first, on source that may not even parse yet.
 *
 * `lint(source)` never throws and never assumes the source is valid. It
 * returns every issue it can find — parse errors, validator findings, and
 * lint warnings — folded into one {@link RuleIssue} list. A caller filtering
 * for `origin === 'parse'` gets the compile blockers; the rest is advisory.
 */

import { lintFirestoreRules } from '../linter/linter.js';
import { parseToAST } from '../grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../grammar/FirestoreValidator.js';
import type { RuleIssue } from './issue.js';
import {
  parseErrorToIssue,
  lintWarningToIssue,
  validationFindingToIssue,
} from './issue.js';

/**
 * Lint Firestore rules source. Accepts anything — including empty or
 * syntactically broken source — and always returns an issue list.
 */
export function lint(source: string): RuleIssue[] {
  const issues: RuleIssue[] = [];

  let lintResult: ReturnType<typeof lintFirestoreRules>;
  try {
    lintResult = lintFirestoreRules(source);
  } catch (e) {
    // The linter itself should not throw, but a tolerant front door must
    // survive one that does — surface it as an issue rather than propagate.
    return [
      {
        code: 'LINT_INTERNAL_ERROR',
        severity: 'error',
        message: e instanceof Error ? e.message : String(e),
        origin: 'lint',
      },
    ];
  }

  if (lintResult.parseError) {
    // Source did not parse — the parse error is the whole story; budget
    // checks and validation were skipped.
    issues.push(parseErrorToIssue(lintResult.parseError));
    return issues;
  }

  for (const warning of lintResult.warnings) {
    issues.push(lintWarningToIssue(warning));
  }

  // Source parsed — layer in structural/security findings from the validator.
  try {
    const ast = parseToAST(source);
    if (ast) {
      for (const finding of validateFirestoreRules(ast)) {
        issues.push(validationFindingToIssue(finding));
      }
    }
  } catch {
    // Validation is best-effort in the tolerant path; a crash here must not
    // sink the lint warnings already collected.
  }

  return issues;
}
