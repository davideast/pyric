/**
 * The assertion adapter layer — the bridge from the data-returning front
 * door to a throwing test runner.
 *
 * `simulate` never throws; a runner needs failures to throw. These adapters
 * are that seam, and the ONLY throwing verbs beyond the constructors:
 *   - `eachCase(rulesetOrSource, cases)` yields one runnable per case, ready
 *     to wire into `test(name, run)`.
 *   - `assertCase(result)` throws on a failed or abstained result.
 *   - `explainCase(result)` renders the single sanctioned trace string —
 *     used verbatim as the thrown error's message, so a runner surfaces the
 *     "why" for free.
 */

import { firestoreRules } from './firestore.js';
import type { FirestoreRuleset } from './firestore.js';
import type { RtdbRuleset } from './rtdb.js';
import { RulesAssertionError, RulesUnsupportedError } from './errors.js';
import type { RuleEvaluation } from '../test/spec.js';
import type {
  FirestoreCase,
  CaseResult,
  RtdbCase,
  RtdbCaseResult,
} from './case-types.js';

/** One runnable case produced by {@link eachCase}. Wire `run` straight into
 *  a test runner: `for (const c of eachCase(...)) test(c.name, c.run)`. */
export interface RunnerCase<C> {
  /** Human-readable name — the case description, or a path-derived fallback. */
  name: string;
  /** The originating case. */
  case: C;
  /** Simulate this one case and throw on failure/abstention. */
  run(): void;
}

function isRtdbResult(r: CaseResult | RtdbCaseResult): r is RtdbCaseResult {
  return 'matchedRule' in r;
}

// ─── Trace rendering ─────────────────────────────────────────────────

function renderRuleEvaluation(entry: RuleEvaluation): string {
  const ops = entry.operations.join(',');
  const loc = entry.line !== undefined ? ` (line ${entry.line})` : '';
  const block = entry.matchPath ? ` [${entry.matchPath}]` : '';
  const cond = entry.conditionText ? `: ${entry.conditionText}` : '';
  const msg = entry.message ? ` (${entry.message})` : '';
  return `    #${entry.ruleIndex} (${ops})${block}${loc} -> ${entry.verdict}${cond}${msg}`;
}

function renderFirestore(r: CaseResult): string {
  const status = r.unsupported ? 'UNSUPPORTED' : r.passed ? 'PASS' : 'FAIL';
  const lines: string[] = [
    `${status}: ${r.description}`,
    `  ${r.case.method} ${r.case.path} (expected ${r.expectation}, got ${r.decision})`,
  ];
  if (r.trace.length > 0) {
    lines.push('  rules evaluated:');
    for (const entry of r.trace) lines.push(renderRuleEvaluation(entry));
  }
  if (r.pathResolution && r.pathResolution.attempts.length > 0) {
    const misses = r.pathResolution.attempts.filter((a) => !a.matched);
    if (misses.length > 0) {
      lines.push('  path near-misses:');
      for (const a of misses) {
        lines.push(
          `    ${a.blockPath} (${a.matchedSegments}/${a.totalSegments} segments${a.reason ? `, ${a.reason}` : ''})`,
        );
      }
    }
  }
  for (const note of r.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

function renderRtdb(r: RtdbCaseResult): string {
  const status = r.unsupported ? 'UNSUPPORTED' : r.passed ? 'PASS' : 'FAIL';
  const name = r.description ?? `${r.case.operation} ${r.case.path}`;
  return [
    `${status}: ${name}`,
    `  ${r.case.operation} ${r.case.path} (expected ${r.expectation}, got ${r.decision})`,
    `  matched ${r.matchedRule} @ ${r.matchedPath}`,
    `  reason: ${r.reason}`,
  ].join('\n');
}

/**
 * Render a case result as a human-readable trace. The single sanctioned
 * trace renderer — used as the message of the error `assertCase` throws, and
 * available directly for logging a result without asserting.
 */
export function explainCase(result: CaseResult | RtdbCaseResult): string {
  return isRtdbResult(result) ? renderRtdb(result) : renderFirestore(result);
}

/**
 * Throw when a case result did not pass. A simulator abstention throws
 * {@link RulesUnsupportedError}; a genuine expectation mismatch throws
 * {@link RulesAssertionError}. Both carry the {@link explainCase} trace as
 * their message. Returns `void` on a passing result.
 */
export function assertCase(result: CaseResult | RtdbCaseResult): void {
  if (result.unsupported) {
    throw new RulesUnsupportedError(explainCase(result));
  }
  if (!result.passed) {
    throw new RulesAssertionError(explainCase(result));
  }
}

// ─── eachCase ────────────────────────────────────────────────────────

function caseName(c: FirestoreCase | RtdbCase): string {
  if (c.description) return c.description;
  if ('method' in c) return `${c.method} ${c.path}`;
  return `${c.operation} ${c.path}`;
}

export function eachCase(
  rulesetOrSource: string | FirestoreRuleset,
  cases: FirestoreCase[],
): RunnerCase<FirestoreCase>[];
export function eachCase(
  ruleset: RtdbRuleset,
  cases: RtdbCase[],
): RunnerCase<RtdbCase>[];
export function eachCase(
  rulesetOrSource: string | FirestoreRuleset | RtdbRuleset,
  cases: FirestoreCase[] | RtdbCase[],
): RunnerCase<FirestoreCase>[] | RunnerCase<RtdbCase>[] {
  const ruleset: FirestoreRuleset | RtdbRuleset =
    typeof rulesetOrSource === 'string'
      ? firestoreRules(rulesetOrSource)
      : rulesetOrSource;

  return (cases as Array<FirestoreCase | RtdbCase>).map((c) => ({
    name: caseName(c),
    case: c as never,
    run(): void {
      // `simulate` on either ruleset accepts a one-element array of the
      // matching case type and returns one result; `assertCase` throws on
      // failure/abstention.
      const summary = (ruleset as FirestoreRuleset).simulate([c as FirestoreCase]);
      assertCase(summary.cases[0]);
    },
  })) as RunnerCase<FirestoreCase>[] | RunnerCase<RtdbCase>[];
}
