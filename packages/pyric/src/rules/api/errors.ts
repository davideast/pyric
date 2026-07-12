/**
 * The three error types the rules front door throws — and the only places
 * it throws at all. Constructing a ruleset from unparseable source throws
 * {@link RulesCompileError}; the assertion adapters throw
 * {@link RulesAssertionError} on a failed case and
 * {@link RulesUnsupportedError} on an abstention. Everything else returns
 * data.
 */

import type { RuleIssue } from './issue.js';

/**
 * Thrown by `firestoreRules(source)` / `rtdbRules(...)` when the source
 * cannot compile. Carries the compile-blocking issues on `.issues` so a
 * caller can surface them without re-parsing.
 */
export class RulesCompileError extends Error {
  readonly issues: RuleIssue[];
  constructor(message: string, issues: RuleIssue[]) {
    super(message);
    this.name = 'RulesCompileError';
    this.issues = issues;
  }
}

/**
 * Thrown by `assertCase` / a runner case's `run()` when the simulated
 * decision did not match the case's expectation. The message is the
 * rendered trace from `explainCase`, so a test runner surfaces the "why"
 * without extra wiring.
 */
export class RulesAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesAssertionError';
  }
}

/**
 * Thrown by `assertCase` / a runner case's `run()` when the simulator
 * abstained — it hit a feature it does not implement, so neither a pass nor
 * a genuine failure can be asserted. Distinct from
 * {@link RulesAssertionError} so a runner can choose to skip rather than
 * fail on a known simulator gap.
 */
export class RulesUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesUnsupportedError';
  }
}
