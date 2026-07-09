/**
 * Rules-failure debugging (Pyric Studio F4): public surface.
 *
 * `SPEC.md`: the prose spec — what this page shows per service, and where.
 * `model.ts`: pure denial projection + rule explanation over the event stream.
 * `rerun.ts`: the two re-run paths (impersonate live; edited-ruleset fork+diff).
 * `RulesDebug.tsx`: the pure-props UI (denial list → rule/auth/context → re-run).
 * `RulesDebugPane.tsx`: the Studio-pane wrapper (backend-aware) mounted in the
 *                        Rules tab.
 */

export {
  selectDenials,
  toDenial,
  explainDenial,
  denialSeverity,
  rerunSupport,
  type Denial,
  type RuleVerdict,
  type RuleExplanation,
  type RuleEngine,
  type RulePhase,
  type DenialSeverity,
  type RerunSupport,
  type ServiceRerunSupport,
} from './model.js';
export {
  rerunAgainstRules,
  rerunAsUser,
  issueOp,
  lintEditedRuleset,
  type RerunResult,
  type EditedRulesetRerun,
  type RulesetLint,
  type RulesetLintFinding,
  type ImpersonationClient,
} from './rerun.js';
export { RulesDebug, type RulesDebugProps } from './RulesDebug.js';
export { RulesDebugPane } from './RulesDebugPane.js';
