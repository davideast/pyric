import type { ValidationFinding } from '../grammar/FirestoreValidator.js';
import type { LintWarning, RulesMetrics } from '../linter/linter.js';
import type { ParseError } from '../grammar/FirestoreParser.js';

export type WriteFirestoreRulesResult =
  | { success: true; data: { rulesetId: string; findings: ValidationFinding[]; lint: { warnings: LintWarning[]; metrics: RulesMetrics } } }
  | { success: false; error: { code: string; message: string; recoverable: boolean; findings?: ValidationFinding[]; lint?: { warnings: LintWarning[]; metrics: RulesMetrics }; parseError?: ParseError } };
