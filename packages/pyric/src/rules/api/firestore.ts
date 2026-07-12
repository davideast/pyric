/**
 * `firestoreRules(source)` — the deep, safe-by-default handle on a Firestore
 * ruleset.
 *
 * The constructor compiles once. If the source does not parse it throws
 * {@link RulesCompileError} (with `.issues`); past that point the handle is
 * known-good and its verbs never throw on rule outcomes. `simulate` returns
 * a summary whether cases pass, fail, or hit an unimplemented feature;
 * `lint` returns findings; `explain` returns a structured account of a
 * single case; `toJSON` returns the parsed rules as plain data.
 */

import type { FirestoreRules } from '../grammar/FirestoreAST.js';
import { parseToASTOrError } from '../grammar/FirestoreParser.js';
import { lintFirestoreRules } from '../linter/linter.js';
import { validateFirestoreRules } from '../grammar/FirestoreValidator.js';
import { SimulateFirestoreRulesHandler } from '../simulator/handler.js';
import { projectEvaluatedRule } from '../test/spec.js';
import type { TestCase, TestResult } from '../test/spec.js';
import { RulesCompileError } from './errors.js';
import type { RuleIssue } from './issue.js';
import {
  parseErrorToIssue,
  lintWarningToIssue,
  validationFindingToIssue,
} from './issue.js';
import type {
  FirestoreCase,
  CaseResult,
  Explanation,
  SimulationSummary,
} from './case-types.js';

export interface FirestoreRuleset {
  /** Structural, security, and budget findings on the compiled ruleset.
   *  No parse errors — the source already compiled. */
  lint(): RuleIssue[];
  /** Run every case. Never throws on a rule outcome: a denied or abstained
   *  case is reported in the returned summary. */
  simulate(cases: FirestoreCase[]): SimulationSummary;
  /** The structured account of why one case resolved as it did. */
  explain(oneCase: FirestoreCase): Explanation;
  /** The parsed ruleset as plain data (the AST). */
  toJSON(): FirestoreRules;
}

function resultToCaseResult(fc: FirestoreCase, r: TestResult): CaseResult {
  return {
    case: fc,
    description: r.description,
    expectation: r.expectation,
    decision: r.decision,
    passed: r.state === 'PASSED',
    unsupported: r.state === 'UNSUPPORTED',
    trace: r.trace,
    notes: r.notes,
    ...(r.pathResolution ? { pathResolution: r.pathResolution } : {}),
  };
}

/** A degenerate result for a case the engine could not even run (e.g. the
 *  compiled source went empty). Reported as failed rather than thrown. */
function unrunnableResult(fc: FirestoreCase, message: string): CaseResult {
  return {
    case: fc,
    description: fc.description,
    expectation: fc.expectation,
    decision: 'DENY',
    passed: false,
    unsupported: false,
    trace: [],
    notes: [message],
  };
}

class FirestoreRulesetImpl implements FirestoreRuleset {
  private readonly handler = new SimulateFirestoreRulesHandler();
  constructor(
    private readonly source: string,
    private readonly ast: FirestoreRules,
  ) {}

  lint(): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const warning of lintFirestoreRules(this.source).warnings) {
      issues.push(lintWarningToIssue(warning));
    }
    for (const finding of validateFirestoreRules(this.ast)) {
      issues.push(validationFindingToIssue(finding));
    }
    return issues;
  }

  simulate(cases: FirestoreCase[]): SimulationSummary {
    const result = this.handler.simulate(this.source, cases as TestCase[]);
    if (!result.success) {
      // The source compiled in the constructor, so a parse failure here is
      // not expected — but the front door must not throw. Report every case
      // as failed with the engine's message.
      const message = result.error.message;
      const caseResults = cases.map((c) => unrunnableResult(c, message));
      return {
        passed: 0,
        failed: caseResults.length,
        unsupported: 0,
        cases: caseResults,
      };
    }
    const caseResults = result.data.results.map((r, i) =>
      resultToCaseResult(cases[i], r),
    );
    return {
      passed: result.data.passed,
      failed: result.data.failed,
      unsupported: result.data.unsupported,
      cases: caseResults,
    };
  }

  explain(oneCase: FirestoreCase): Explanation {
    const summary = this.simulate([oneCase]);
    const r = summary.cases[0];
    const deciding = toEngineResult(r);
    const explanation: Explanation = {
      decision: r.decision,
      expectation: r.expectation,
      passed: r.passed,
      unsupported: r.unsupported,
      trace: r.trace,
      notes: r.notes,
    };
    if (deciding) explanation.deciding = deciding;
    if (r.pathResolution) explanation.pathResolution = r.pathResolution;
    return explanation;
  }

  toJSON(): FirestoreRules {
    return this.ast;
  }
}

/** Reconstruct the minimal `TestResult` shape `projectEvaluatedRule` needs
 *  from a `CaseResult`, so the deciding-rule projection stays a single
 *  implementation shared with the engine. */
function toEngineResult(r: CaseResult) {
  return projectEvaluatedRule({
    description: r.description,
    expectation: r.expectation,
    state: r.passed ? 'PASSED' : r.unsupported ? 'UNSUPPORTED' : 'FAILED',
    decision: r.decision,
    trace: r.trace,
    notes: r.notes,
    ...(r.pathResolution ? { pathResolution: r.pathResolution } : {}),
  });
}

/**
 * Compile Firestore rules source into a deep, safe-by-default handle.
 *
 * @throws {RulesCompileError} when the source does not parse. The thrown
 *   error carries the compile-blocking issues on `.issues`.
 */
export function firestoreRules(source: string): FirestoreRuleset {
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    const issues: RuleIssue[] = [parseErrorToIssue(parsed.error)];
    throw new RulesCompileError(
      'Firestore rules source failed to compile',
      issues,
    );
  }
  return new FirestoreRulesetImpl(source, parsed.ast);
}
