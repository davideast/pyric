// Decides whether a failed run blocks. It does not block only when every
// condition below holds; otherwise the run keeps its own exit code:
//   - the process exited with code 1;
//   - its JUnit file exists and parses;
//   - at least one test failed in it;
//   - the console's `N fail` total equals the JUnit failure count;
//   - bun reported no error outside a test;
//   - every failure matches an active (unexpired) quarantine entry.

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
  /** Each active entry's result in this run. */
  outcomes: EntryOutcome[];
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
function blockingReason(evidence: RunEvidence, failures: TestResult[], unmatched: TestResult[]): string | undefined {
  const exitedWithOne = evidence.exitCode === 1;
  if (!exitedWithOne) return `the run exited with ${evidence.exitCode ?? 'a signal'}, not 1`;
  if (evidence.results === undefined) return 'the JUnit file is missing or did not parse';
  if (failures.length === 0) return 'the JUnit file names no failing test';
  const countsMatch = evidence.totals.fail === failures.length;
  if (!countsMatch) return `the console counts ${evidence.totals.fail ?? 'no'} fail, the JUnit file ${failures.length}`;
  const errorsOutsideTests = evidence.totals.errors > 0;
  if (errorsOutsideTests) return `bun reported ${evidence.totals.errors} error(s) outside a test`;
  if (unmatched.length > 0) return `${unmatched.length} failing test(s) are not quarantined`;
  return undefined;
}

export function decide(evidence: RunEvidence, entries: LoadedEntry[], today: string): Verdict {
  const active = entries.filter((entry) => isActive(entry, today));
  const lapsed = entries.filter((entry) => !isActive(entry, today));
  const results = evidence.results ?? [];
  const failures = results.filter((result) => result.outcome === 'failed');
  const quarantined: Match[] = [];
  const expired: Match[] = [];
  const unmatched: TestResult[] = [];
  for (const result of failures) {
    const entry = firstMatch(active, result);
    const lapsedEntry = firstMatch(lapsed, result);
    if (entry) quarantined.push({ result, entry });
    else unmatched.push(result);
    if (!entry && lapsedEntry) expired.push({ result, entry: lapsedEntry });
  }
  const outcomes = active.map((entry) => ({ entry, outcome: outcomeOf(entry, results) }));
  const base = { quarantined, expired, outcomes };
  if (evidence.exitCode === 0) return { ...base, exitCode: 0, forgiven: false, reason: 'the run passed' };
  const reason = blockingReason(evidence, failures, unmatched);
  if (reason !== undefined) return { ...base, exitCode: evidence.exitCode ?? 1, forgiven: false, reason };
  return { ...base, exitCode: 0, forgiven: true, reason: 'every failing test is quarantined' };
}
