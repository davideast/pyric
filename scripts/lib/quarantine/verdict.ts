// Decides whether a failed run blocks. It does not block only when every
// condition below holds; otherwise the run keeps its own exit code:
//   - the process exited with code 1;
//   - its JUnit file exists and parses;
//   - at least one test failed in it;
//   - the console's `N fail` total equals the JUnit failure count;
//   - bun reported no error outside a test;
//   - every failure matches an active (unexpired) quarantine entry;
//   - each such entry names exactly one testcase in the run, so a duplicate
//     name, a `test.each` case or a retried attempt is never forgiven.
// A test's outcome is its last attempt's: bun lists each retry attempt as its
// own testcase, one after another on the same line, and counts only the last.

import { isActive, matches, ran, type LoadedEntry, type TestResult } from './entries.ts';
import type { ConsoleTotals } from './junit.ts';

export interface RunEvidence {
  exitCode: number | null;
  /** Undefined when the JUnit file is missing or did not parse. */
  results?: TestResult[];
  totals: ConsoleTotals;
}

export interface Match {
  result: TestResult;
  entry: LoadedEntry;
}

export interface EntryOutcome {
  entry: LoadedEntry;
  outcome: 'passed' | 'failed' | 'not-run';
}

export interface Verdict {
  /** The exit code the run ends with. */
  exitCode: number;
  /** True when the run failed and only quarantined tests failed. */
  forgiven: boolean;
  reason: string;
  /** Failures an active entry covers. */
  quarantined: Match[];
  /** Failures only an expired entry covers. They block. */
  expired: Match[];
  /** Failures whose active entry names more than one testcase. They block. */
  ambiguous: Match[];
  /** Each active entry's result in this run. */
  outcomes: EntryOutcome[];
}

function sameTest(a: TestResult, b: TestResult): boolean {
  return a.id === b.id && a.line !== undefined && a.line === b.line;
}

/** Each test once, with its last attempt's outcome. */
export function finalResults(results: TestResult[]): TestResult[] {
  const final: TestResult[] = [];
  for (const result of results) {
    const previous = final.at(-1);
    const isRetry = previous !== undefined && sameTest(previous, result);
    if (isRetry) final[final.length - 1] = result;
    else final.push(result);
  }
  return final;
}

function firstMatch(entries: LoadedEntry[], result: TestResult): LoadedEntry | undefined {
  return entries.find((entry) => matches(entry, result));
}

function outcomeOf(entry: LoadedEntry, results: TestResult[]): EntryOutcome['outcome'] {
  const covered = results.filter((result) => ran(entry, result));
  const failed = covered.some((result) => result.outcome === 'failed' && matches(entry, result));
  if (failed) return 'failed';
  const passed = covered.some((result) => result.outcome === 'passed');
  if (passed) return 'passed';
  return 'not-run';
}

/** Why the run's own exit code stands, or undefined when it may be forgiven. */
function blockingReason(evidence: RunEvidence, failures: TestResult[], unmatched: TestResult[], ambiguous: Match[]): string | undefined {
  const exitedWithOne = evidence.exitCode === 1;
  if (!exitedWithOne) return `the run exited with ${evidence.exitCode ?? 'a signal'}, not 1`;
  if (evidence.results === undefined) return 'the JUnit file is missing or did not parse';
  if (failures.length === 0) return 'the JUnit file names no failing test';
  const countsMatch = evidence.totals.fail === failures.length;
  if (!countsMatch) return `the console counts ${evidence.totals.fail ?? 'no'} fail, the JUnit file ${failures.length}`;
  const errorsOutsideTests = evidence.totals.errors > 0;
  if (errorsOutsideTests) return `bun reported ${evidence.totals.errors} error(s) outside a test`;
  if (ambiguous.length > 0) return `${ambiguous.length} quarantined failure(s) name more than one testcase in the run (a duplicate name, a test.each case, or a retry)`;
  if (unmatched.length > 0) return `${unmatched.length} failing test(s) are not quarantined`;
  return undefined;
}

export function decide(evidence: RunEvidence, entries: LoadedEntry[], today: string): Verdict {
  const active = entries.filter((entry) => isActive(entry, today));
  const lapsed = entries.filter((entry) => !isActive(entry, today));
  const raw = evidence.results ?? [];
  const results = finalResults(raw);
  const failures = results.filter((result) => result.outcome === 'failed');
  const quarantined: Match[] = [];
  const expired: Match[] = [];
  const ambiguous: Match[] = [];
  const unmatched: TestResult[] = [];
  for (const result of failures) {
    const entry = firstMatch(active, result);
    const namesOneTestcase = entry !== undefined && raw.filter((other) => matches(entry, other)).length === 1;
    if (entry && namesOneTestcase) quarantined.push({ result, entry });
    else unmatched.push(result);
    if (entry && !namesOneTestcase) ambiguous.push({ result, entry });
    const lapsedEntry = firstMatch(lapsed, result);
    if (!entry && lapsedEntry) expired.push({ result, entry: lapsedEntry });
  }
  const outcomes = active.map((entry) => ({ entry, outcome: outcomeOf(entry, results) }));
  const base = { quarantined, expired, ambiguous, outcomes };
  if (evidence.exitCode === 0) return { ...base, exitCode: 0, forgiven: false, reason: 'the run passed' };
  const reason = blockingReason(evidence, failures, unmatched, ambiguous);
  if (reason !== undefined) return { ...base, exitCode: evidence.exitCode ?? 1, forgiven: false, reason };
  return { ...base, exitCode: 0, forgiven: true, reason: 'every failing test is quarantined' };
}
