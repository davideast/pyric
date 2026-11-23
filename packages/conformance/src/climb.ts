#!/usr/bin/env bun
/**
 * The climb lane (Conformance Driven Development; see `docs/conformance/cdd.md`
 * Step 5, and the resolved decisions section).
 *
 * WHAT THIS IS. A **report** about the climb and a **gate** only against
 * regression -- the glossary's two roles kept from blurring (report informs; gate
 * can fail the build). For every `climb: true` surface descriptor it runs that
 * surface's `conformanceSuite` via `bun test` (with `PYRIC_CLIMB=1` in the child
 * env), maps each assertion set back to the row id it tests, and prints the pass
 * rate: green rows over total, alongside the registry's own conforms-over-total
 * count (cdd.md Step 5.3 -- the two should agree; disagreement is drift and the
 * lane says so).
 *
 * WHAT IT IS NOT. It is NOT wired into CI (resolved decision #1: the climb is an
 * experiment and costs main-branch velocity nothing; it runs on demand on the
 * WIP branch). This script touches no workflow. It is on-demand only:
 * `bun run compat:climb` (add `--json` for automation, or
 * `--surface=<key>` to isolate one surface from other active climbs).
 *
 * THE ONE EXIT RULE (the regression rule, cdd.md Step 5.5 / Step 6). The lane
 * exits nonzero **if and only if** a row whose registry status is expected-green
 * (`conforms`, or `diverged-documented` whose two-sided pin should hold) is
 * mapped to a failing or skipped assertion set -- a previously-green row gone
 * red or disabled. Failures and skips of `unverified` rows are expected during
 * the climb and never affect the exit code; a surface with zero expected-green
 * rows always exits zero with a pass-rate report.
 *
 * SUITE CONVENTION (coordinated with cdd.md Step 3). Each row id gets exactly
 * one named block in the suite ("one assertion set per row"). `bun test`'s JUnit
 * reporter stamps the enclosing describe-block name onto every `<testcase>` as
 * its `classname` (nested describes are joined with ` > `), so a testcase is
 * mapped to a row when that row's id appears as a delimited token in the
 * testcase's `classname` (or `name`). A row is GREEN when it has at least one
 * mapped testcase and none failed or skipped, RED when any mapped testcase
 * failed, SKIPPED when none failed and at least one skipped, and UNMAPPED when
 * the suite has no assertion set for it yet.
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { allCompatibilityRows, type CompatStatus, type ConformanceDisposition } from '../registry/index.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';
import {
  printClimbConsoleReport,
  renderClimbJson,
  type RowResult,
  type RowVerdict,
  type SuiteOutcome,
  type SurfaceResult,
} from './climb-report.ts';
import { REPO_ROOT } from './ledger.ts';

/**
 * Registry statuses that the lane treats as "expected green" and therefore
 * guards against regression. `conforms` is the core case named by the regression
 * rule. `diverged-documented` is included because cdd.md Step 6 is explicit that
 * a `diverged-documented` row "counts like a green row: its two-sided pin is
 * expected to pass, and a failure of the pin is a regression that fails the
 * lane."
 */
const REGRESSION_STATUSES: readonly CompatStatus[] = ['conforms', 'diverged-documented'];

export interface TestCase {
  name: string;
  classname: string;
  passed: boolean;
  skipped?: boolean;
}

/** The registry facts one row contributes to a classification. */
export interface RowInput {
  id: string;
  status: CompatStatus;
  conformanceDisposition?: ConformanceDisposition;
}

export interface Classification {
  rows: RowResult[];
  greenRows: number;
  redRows: number;
  skippedRows: number;
  unmappedRows: number;
  /**
   * Green rows the registry does NOT yet call conforming -- assertion sets that
   * pass for rows not yet flipped (cdd.md Step 4 makes the flip a separate
   * reviewed step, so during the climb green routinely runs ahead of conforms).
   * This is the healthy climb direction, reported as informational, never gated.
   */
  flipCandidates: RowResult[];
  regressions: RowResult[];
  unguarded: RowResult[];
  unkeyedTests: number;
  unkeyedFailures: number;
  unkeyedSkipped: number;
}

/** Undo the XML entity escaping the JUnit reporter applies to attribute values. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  if (!match) {
    return '';
  }
  return unescapeXml(match[1] ?? '');
}

/**
 * Parse the JUnit XML into a flat testcase list. The reporter emits either a
 * self-closing `<testcase ... />` (pass) or `<testcase ...>...</testcase>` with
 * `<failure>`, `<error>`, or `<skipped>` children. Skipped testcases (`test.skip`,
 * `describe.skip`, `test.todo`) did not execute and must never count as passed.
 */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[3] ?? '';
    const failed = /<failure\b/.test(inner) || /<error\b/.test(inner);
    const skipped = !failed && (/<skipped\b/.test(inner) || attr(attrs, 'status') === 'skipped');
    const passed = !failed && !skipped;
    cases.push({
      name: attr(attrs, 'name'),
      classname: attr(attrs, 'classname'),
      passed,
      skipped,
    });
  }
  return cases;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `rowId` appears as a delimited token in `haystack`. The boundaries
 * stop `messaging#1` from matching inside `messaging#12` (right side: not
 * followed by another word char) and stop it from being glued to a longer id on
 * the left. `#` and `-` are treated as id-internal so a leading boundary is a
 * genuine separator, never mid-id.
 */
export function mentionsRow(haystack: string, rowId: string): boolean {
  const re = new RegExp(`(?:^|[^\\w#-])${escapeRegExp(rowId)}(?!\\w)`);
  return re.test(haystack);
}

interface RowTally {
  tests: number;
  failed: number;
  skipped: number;
}

function decideRowVerdict(agg: RowTally): RowVerdict {
  if (agg.tests === 0) {
    return 'unmapped';
  }
  if (agg.failed > 0) {
    return 'red';
  }
  if (agg.skipped > 0) {
    return 'skipped';
  }
  return 'green';
}

function isSkippedTestCase(tc: TestCase): boolean {
  return tc.skipped === true;
}

function isFailedTestCase(tc: TestCase): boolean {
  return tc.skipped !== true && !tc.passed;
}

/**
 * The pure core of the lane: given the surface's rows and the suite's testcases,
 * map each testcase to the row id(s) it names and decide each row's verdict.
 * Extracted from `evaluateSurface` so the regression rule and the boundary
 * matching are unit-testable without spawning `bun test`.
 */
export function classifyRows(rows: RowInput[], testcases: TestCase[]): Classification {
  const expectedGreen = (status: CompatStatus): boolean => REGRESSION_STATUSES.includes(status);
  const perRow = new Map<string, RowTally>();
  for (const row of rows) {
    perRow.set(row.id, { tests: 0, failed: 0, skipped: 0 });
  }

  let unkeyedTests = 0;
  let unkeyedFailures = 0;
  let unkeyedSkipped = 0;
  for (const tc of testcases) {
    const haystack = `${tc.classname} ${tc.name}`;
    const matched = rows.filter((r) => mentionsRow(haystack, r.id));
    if (matched.length === 0) {
      unkeyedTests += 1;
      if (isSkippedTestCase(tc)) {
        unkeyedSkipped += 1;
      } else if (isFailedTestCase(tc)) {
        unkeyedFailures += 1;
      }
      continue;
    }
    for (const row of matched) {
      const agg = perRow.get(row.id);
      if (!agg) {
        continue;
      }
      agg.tests += 1;
      if (isSkippedTestCase(tc)) {
        agg.skipped += 1;
      } else if (isFailedTestCase(tc)) {
        agg.failed += 1;
      }
    }
  }

  const results: RowResult[] = rows.map((r) => {
    const agg = perRow.get(r.id) ?? { tests: 0, failed: 0, skipped: 0 };
    const verdict = decideRowVerdict(agg);
    const eg = expectedGreen(r.status);
    const regressed = eg && (verdict === 'red' || verdict === 'skipped');
    const rowResult: RowResult = {
      id: r.id,
      status: r.status,
      expectedGreen: eg,
      verdict,
      tests: agg.tests,
      failed: agg.failed,
      skipped: agg.skipped,
      regressed,
    };
    if (r.conformanceDisposition !== undefined) {
      rowResult.conformanceDisposition = r.conformanceDisposition;
    }
    return rowResult;
  });

  return {
    rows: results,
    greenRows: results.filter((r) => r.verdict === 'green').length,
    redRows: results.filter((r) => r.verdict === 'red').length,
    skippedRows: results.filter((r) => r.verdict === 'skipped').length,
    unmappedRows: results.filter((r) => r.verdict === 'unmapped').length,
    flipCandidates: results.filter((r) => r.verdict === 'green' && r.status === 'unverified'),
    regressions: results.filter((r) => r.regressed),
    unguarded: results.filter((r) => r.expectedGreen && r.verdict === 'unmapped'),
    unkeyedTests,
    unkeyedFailures,
    unkeyedSkipped,
  };
}

function runNativeScript(runnerScript: string, suitePath: string, xmlOut: string): { outcome: SuiteOutcome; stderr: string } {
  const result = spawnSync('bash', [runnerScript, suitePath, xmlOut], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYRIC_CLIMB: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0 && existsSync(xmlOut) && statSync(xmlOut).size > 0) {
    return { outcome: 'ran', stderr: result.stderr ?? '' };
  }
  return { outcome: 'errored', stderr: result.stderr ?? '' };
}

function runSuite(
  suitePath: string,
  xmlOut: string,
  descriptor?: (typeof surfaceDescriptors)[number],
): { outcome: SuiteOutcome; stderr: string } {
  if (suitePath.endsWith('.dart') || descriptor?.surface === 'firestore-flutter') {
    return runNativeScript(join(REPO_ROOT, 'scripts/run-flutter-conformance.sh'), suitePath, xmlOut);
  }
  if (suitePath.endsWith('.kt') || descriptor?.surface === 'firestore-kotlin') {
    return runNativeScript(join(REPO_ROOT, 'scripts/run-kotlin-conformance.sh'), suitePath, xmlOut);
  }
  if (suitePath.endsWith('.swift') || descriptor?.surface === 'firestore-swift') {
    return runNativeScript(join(REPO_ROOT, 'scripts/run-swift-conformance.sh'), suitePath, xmlOut);
  }

  const result = spawnSync('bun', ['test', suitePath, '--reporter=junit', `--reporter-outfile=${xmlOut}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYRIC_CLIMB: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // bun exits nonzero both when the suite has failing tests (expected here) and
  // when it cannot run at all. The written XML is the discriminator: a suite that
  // ran produces it; a load/compile error produces none.
  if (existsSync(xmlOut) && statSync(xmlOut).size > 0) {
    return { outcome: 'ran', stderr: result.stderr ?? '' };
  }
  return { outcome: 'errored', stderr: result.stderr ?? '' };
}

function unmappedSurfaceResult(
  base: Pick<SurfaceResult, 'surface' | 'suite' | 'totalRows' | 'conformingRows' | 'expectedGreenRows'>,
  rows: readonly RowInput[],
  expectedGreenIds: ReadonlySet<string>,
  suiteOutcome: 'missing' | 'errored',
  note: string,
): SurfaceResult {
  const rowResults: RowResult[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    expectedGreen: expectedGreenIds.has(r.id),
    verdict: 'unmapped',
    tests: 0,
    failed: 0,
    skipped: 0,
    regressed: false,
  }));
  return {
    ...base,
    suiteOutcome,
    greenRows: 0,
    redRows: 0,
    skippedRows: 0,
    unmappedRows: rows.length,
    testsTotal: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    unkeyedTests: 0,
    unkeyedFailures: 0,
    unkeyedSkipped: 0,
    rows: rowResults,
    regressions: [],
    unguarded: rowResults.filter((r) => r.expectedGreen),
    flipCandidates: [],
    overclaims: expectedGreenIds.size !== 0,
    note,
  };
}

function removeFileIfPresent(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

function evaluateSurface(
  descriptor: (typeof surfaceDescriptors)[number],
  xmlDir: string,
  seq: number,
): SurfaceResult {
  const rows = allCompatibilityRows.filter((r) => r.surface === descriptor.surface);
  const suite = descriptor.conformanceSuite ?? null;
  const conformingRows = rows.filter((r) => r.status === 'conforms').length;
  const expectedGreenIds = new Set(
    rows.filter((r) => REGRESSION_STATUSES.includes(r.status)).map((r) => r.id),
  );

  const base = {
    surface: descriptor.surface,
    suite,
    totalRows: rows.length,
    conformingRows,
    expectedGreenRows: expectedGreenIds.size,
  };

  if (!suite || !existsSync(join(REPO_ROOT, suite))) {
    let missingNote = 'no conformanceSuite path on descriptor';
    if (suite) {
      missingNote = 'suite file not present yet (red at birth)';
    }
    return unmappedSurfaceResult(base, rows, expectedGreenIds, 'missing', missingNote);
  }

  const xmlOut = join(xmlDir, `climb-${process.pid}-${seq}-${descriptor.surface}.xml`);
  removeFileIfPresent(xmlOut);
  try {
    const { outcome, stderr } = runSuite(suite, xmlOut, descriptor);
    if (outcome === 'errored') {
      let errorDetail = '';
      if (stderr.trim() !== '') {
        const lines = stderr.trim().split('\n');
        errorDetail = `: ${lines[lines.length - 1] ?? ''}`;
      }
      return unmappedSurfaceResult(
        base,
        rows,
        expectedGreenIds,
        'errored',
        `suite failed to run (no test output produced)${errorDetail}`,
      );
    }

    const testcases = parseJUnit(readFileSync(xmlOut, 'utf8'));
    const loadError = testcases.find((t) => isFailedTestCase(t) && t.name.startsWith('loading '));
    if (loadError || testcases.length === 0) {
      let loadNote = 'suite produced no test cases';
      if (loadError) {
        loadNote = `suite failed to compile or load: ${loadError.name}`;
      }
      return unmappedSurfaceResult(base, rows, expectedGreenIds, 'errored', loadNote);
    }

    const classified = classifyRows(rows, testcases);
    const testsTotal = testcases.length;
    const testsSkipped = testcases.filter(isSkippedTestCase).length;
    const testsFailed = testcases.filter(isFailedTestCase).length;

    return {
      ...base,
      suiteOutcome: 'ran',
      greenRows: classified.greenRows,
      redRows: classified.redRows,
      skippedRows: classified.skippedRows,
      unmappedRows: classified.unmappedRows,
      testsTotal,
      testsPassed: testsTotal - testsFailed - testsSkipped,
      testsFailed,
      testsSkipped,
      unkeyedTests: classified.unkeyedTests,
      unkeyedFailures: classified.unkeyedFailures,
      unkeyedSkipped: classified.unkeyedSkipped,
      rows: classified.rows,
      regressions: classified.regressions,
      unguarded: classified.unguarded,
      flipCandidates: classified.flipCandidates,
      overclaims: expectedGreenIds.size > classified.greenRows,
    };
  } finally {
    removeFileIfPresent(xmlOut);
  }
}

function main(): void {
  const wantJson = process.argv.includes('--json');
  const requestedSurface = process.argv
    .find((argument) => argument.startsWith('--surface='))
    ?.slice('--surface='.length);
  const climbDescriptors = surfaceDescriptors.filter(
    (descriptor) => descriptor.climb && (!requestedSurface || descriptor.surface === requestedSurface),
  );

  const xmlDir = join(homedir(), '.cache', 'pyric-tmp');
  mkdirSync(xmlDir, { recursive: true });
  const results = climbDescriptors.map((descriptor, idx) => evaluateSurface(descriptor, xmlDir, idx));

  const regressed = results.filter((r) => r.regressions.length > 0);
  let exitCode = 0;
  if (regressed.length > 0) {
    exitCode = 1;
  }

  if (wantJson) {
    console.log(renderClimbJson(results, exitCode, REGRESSION_STATUSES));
    process.exit(exitCode);
  }

  if (climbDescriptors.length === 0) {
    console.log('# Climb lane\n');
    console.log('On-demand CDD climb report (docs/conformance/cdd.md Step 5). Non-blocking:');
    console.log('this lane is NOT a required check; it turns red only on a green-row regression.\n');
    console.log('No surfaces are marked `climb: true`. Nothing to climb.');
    process.exit(0);
  }

  printClimbConsoleReport(results, regressed, exitCode);
  process.exit(exitCode);
}

if (import.meta.main) {
  main();
}
