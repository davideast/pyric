/**
 * Failures the start commit already had. Studio's own gates can fail before
 * any role touches it (an app rule it breaks, a test that needs what the
 * sandbox lacks); a gate like that would fail every hour and say nothing
 * about the roles' work. So the baseline runs the static gates at the start
 * commit and counts each failure by a signature without line numbers, and
 * an hour's failing gate passes only when no signature shows up more often
 * than it did then, in that gate.
 *
 * It fails closed. A gate is never excused when it timed out or was killed,
 * when it named no failure, or when its output has a failure the parse can't
 * name: bun's unhandled errors, a run with no closing "Ran N tests" line
 * after its totals (bun's own totals are the last ones printed), a total of failed tests or errors that
 * differs from the lines read, a type error with no file, an ast-grep error
 * total that differs from the findings read.
 */
import type { GateName, GateResult } from './gates.ts';

/** Each gate's failures at the start commit, with how many times each showed. */
export type KnownFailures = Partial<Record<GateName, Record<string, number>>>;

export interface FailureReport {
  counts: Map<string, number>;
  /** Why the output can't be excused, whatever it names. */
  problems: string[];
}

const TEST_FAILURE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const TEST_RECAP = /^\s*\d+ tests? failed:\s*$/;
const TEST_FAIL_TOTAL = /^\s*(\d+) fail\s*$/;
const TEST_ERROR_TOTAL = /^\s*(\d+) errors?\s*$/;
const TEST_RAN = /^Ran \d+ tests? across \d+ files?\./;
const UNHANDLED = /^# Unhandled error/;
const TS_ERROR = /^(\S.*?)\(\d+,\d+\): error (TS\d+): (.*)$/;
const ANY_TS_ERROR = /\berror TS\d+:/;
const AST_GREP_ERROR = /^error\[([^\]]+)\]/;
const AST_GREP_LOCATION = /┌─ (\S+?):\d+:\d+/;
const AST_GREP_TOTAL = /^Error: (\d+) error\(s\) found/;

function countOf(signatures: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  return counts;
}

/** The last line matching `pattern`: a test can print a total of its own before bun prints the real one. */
function lastIndexOf(lines: readonly string[], pattern: RegExp): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index] ?? '')) return index;
  }
  return -1;
}

function totalOf(lines: readonly string[], pattern: RegExp): number | undefined {
  const index = lastIndexOf(lines, pattern);
  if (index === -1) return undefined;
  return Number(pattern.exec(lines[index] ?? '')?.[1]);
}

/** bun prints each failing test where it ran and again in a closing recap; only the first counts. */
function testReport(lines: readonly string[]): FailureReport {
  const recap = lines.findIndex((line) => TEST_RECAP.test(line));
  const before = recap === -1 ? lines : lines.slice(0, recap);
  const names = before.flatMap((line) => {
    const name = TEST_FAILURE.exec(line.trim())?.[1];
    return name === undefined ? [] : [name];
  });
  const problems: string[] = [];
  if (lines.some((line) => UNHANDLED.test(line))) problems.push('bun reported an unhandled error between tests');
  const errors = totalOf(lines, TEST_ERROR_TOTAL);
  if (errors !== undefined && errors > 0) problems.push(`bun counted ${errors} errors outside tests`);
  const failed = totalOf(lines, TEST_FAIL_TOTAL);
  const closesRun = lastIndexOf(lines, TEST_RAN) > lastIndexOf(lines, TEST_FAIL_TOTAL);
  if (!closesRun) problems.push('bun printed no closing "Ran N tests" line after its totals');
  if (failed === undefined) problems.push('bun printed no fail total');
  else if (failed !== names.length) problems.push(`bun counted ${failed} failed tests and ${names.length} were named`);
  return { counts: countOf(names), problems };
}

function typeReport(lines: readonly string[]): FailureReport {
  const errorLines = lines.filter((line) => ANY_TS_ERROR.test(line));
  const signatures = errorLines.flatMap((line) => {
    const match = TS_ERROR.exec(line);
    return match === null ? [] : [`${match[1]} ${match[2]}: ${match[3]}`];
  });
  const unnamed = errorLines.length - signatures.length;
  const problems = unnamed > 0 ? [`${unnamed} type errors have no file`] : [];
  return { counts: countOf(signatures), problems };
}

/** `rule file` for each error-level finding: the location follows its header within a few lines. */
function scanReport(lines: readonly string[]): FailureReport {
  const signatures: string[] = [];
  const problems: string[] = [];
  lines.forEach((line, index) => {
    const header = AST_GREP_ERROR.exec(line);
    if (header === null) return;
    const location = lines.slice(index + 1, index + 4).map((next) => AST_GREP_LOCATION.exec(next)).find((match) => match !== null);
    if (location === undefined || location === null) problems.push(`the ${header[1]} finding has no location`);
    else signatures.push(`${header[1]} ${location[1]}`);
  });
  const total = totalOf(lines, AST_GREP_TOTAL);
  if (total !== undefined && total !== signatures.length) problems.push(`ast-grep counted ${total} errors and ${signatures.length} were read`);
  return { counts: countOf(signatures), problems };
}

/** The failures a gate's output names, counted, and what in it can't be named. */
export function failureReport(gate: GateName, output: string): FailureReport {
  const lines = output.split('\n');
  if (gate === 'tests') return testReport(lines);
  if (gate === 'typecheck') return typeReport(lines);
  if (gate === 'studio-checks') return scanReport(lines);
  return { counts: new Map(), problems: [`the ${gate} gate's failures are never excused`] };
}

/** Why a failing gate can't be excused by count, before its signatures are compared; undefined when it can be. */
export function unexcusable(result: GateResult): string | undefined {
  if (result.exit?.timedOut === true) return 'it timed out';
  if (result.exit?.code === null) return 'it was killed';
  const report = failureReport(result.gate, result.output ?? '');
  if (report.problems.length > 0) return report.problems.join('; ');
  if (report.counts.size === 0) return 'it named no failure';
  return undefined;
}

/** The start commit's failures, by gate. A gate whose failure can't be counted records nothing, so it is never excused. */
export function knownFailuresOf(results: readonly GateResult[]): KnownFailures {
  const known: KnownFailures = {};
  for (const result of results) {
    const isCountable = !result.passed && unexcusable(result) === undefined;
    if (isCountable) known[result.gate] = Object.fromEntries(failureReport(result.gate, result.output ?? '').counts);
  }
  return known;
}

function failures(count: number): string {
  return count === 1 ? '1 failure' : `${count} failures`;
}

/** Passes a failing gate when no failure it shows is new, or more frequent than at the start commit, in that gate. */
export function excuseKnown(result: GateResult, known: KnownFailures): GateResult {
  if (result.passed) return result;
  const why = unexcusable(result);
  if (why !== undefined) return { ...result, summary: `${result.summary}; not excused: ${why}` };
  const counts = failureReport(result.gate, result.output ?? '').counts;
  const before = known[result.gate] ?? {};
  const knownCount = (signature: string) => (Object.hasOwn(before, signature) ? before[signature] ?? 0 : 0);
  const isNew = ([signature, count]: [string, number]) => count > knownCount(signature);
  const fresh = [...counts].filter(isNew);
  if (fresh.length > 0) return result;
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { ...result, passed: true, summary: `passed apart from ${failures(total)} the start commit already had` };
}
