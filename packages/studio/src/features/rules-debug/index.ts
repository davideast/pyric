/**
 * Rules-failure debugging (Pyric Studio F4): public surface.
 *
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
  type Denial,
  type RuleExplanation,
  type DenialSeverity,
} from './model.js';
export {
  rerunAgainstRules,
  rerunAsUser,
  issueOp,
  type RerunResult,
  type EditedRulesetRerun,
  type ImpersonationClient,
} from './rerun.js';
export { RulesDebug, type RulesDebugProps } from './RulesDebug.js';
export { RulesDebugPane } from './RulesDebugPane.js';
