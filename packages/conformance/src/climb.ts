#!/usr/bin/env bun
/**
 * The climb lane (Conformance Driven Development; see `docs/conformance/cdd.md`
 * Step 5, and the resolved decisions section).
 *
 * WHAT THIS IS. A **report** about the climb and a **gate** only against
 * regression — the glossary's two roles kept from blurring (report informs; gate
 * can fail the build). For every `climb: true` surface descriptor it runs that
 * surface's `conformanceSuite` via `bun test` (with `PYRIC_CLIMB=1` in the child
 * env), maps each assertion set back to the row id it tests, and prints the pass
 * rate: green rows over total, alongside the registry's own conforms-over-total
 * count (cdd.md Step 5.3 — the two should agree; disagreement is drift and the
 * lane says so).
 *
 * WHAT IT IS NOT. It is NOT wired into CI (resolved decision #1: the climb is an
 * experiment and costs main-branch velocity nothing; it runs on demand on the
 * WIP branch). This script touches no workflow. It is on-demand only:
 * `bun run compat:climb` (add `--json` for automation).
 *
 * THE ONE EXIT RULE (the regression rule, cdd.md Step 5.5 / Step 6). The lane
 * exits nonzero **if and only if** a row whose registry status is expected-green
 * (`conforms`, or `diverged-documented` whose two-sided pin should hold) is
 * mapped to a failing assertion set — a previously-green row gone red. Failures
 * of `unverified` rows are the expected red at birth and never affect the exit
 * code; a surface with zero expected-green rows always exits zero with a
 * pass-rate report. See NOTE at REGRESSION_STATUSES for why the set is those two
 * statuses and not `conforms` alone.
 *
 * SUITE CONVENTION (coordinated with cdd.md Step 3). Each row id gets exactly
 * one named block in the suite ("one assertion set per row"). `bun test`'s JUnit
 * reporter stamps the enclosing describe-block name onto every `<testcase>` as
 * its `classname` (nested describes are joined with ` > `), so a testcase is
 * mapped to a row when that row's id appears as a delimited token in the
 * testcase's `classname` (or `name`). A row is GREEN when it has at least one
 * mapped testcase and none failed, RED when any mapped testcase failed, and
 * UNMAPPED when the suite has no assertion set for it yet.
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surfaceDescriptors, allCompatibilityRows, type CompatStatus, type Surface } from '../registry/index.ts';
import { REPO_ROOT, repoRel } from './ledger.ts';

/**
 * Registry statuses that the lane treats as "expected green" and therefore
 * guards against regression. `conforms` is the core case named by the regression
 * rule. `diverged-documented` is included because cdd.md Step 6 is explicit that
 * a `diverged-documented` row "counts like a green row: its two-sided pin is
 * expected to pass, and a failure of the pin is a regression that fails the
 * lane." Both statuses are currently absent from the messaging registry (every
 * row is born `unverified`), so this set is future-proofing: it changes no
 * present behavior, only what happens once rows begin to flip.
 */
const REGRESSION_STATUSES: readonly CompatStatus[] = ['conforms', 'diverged-documented'];

type SuiteOutcome = 'ran' | 'missing' | 'errored';
type RowVerdict = 'green' | 'red' | 'unmapped';

interface RowResult {
  id: string;
  status: CompatStatus;
  expectedGreen: boolean;
  verdict: RowVerdict;
  tests: number;
  failed: number;
  /** Expected-green row mapped to a failing assertion set — the regression case. */
  regressed: boolean;
}

export interface TestCase {
  name: string;
  classname: string;
  passed: boolean;
}

/** The registry facts one row contributes to a classification. */
export interface RowInput {
  id: string;
  status: CompatStatus;
}

interface SurfaceResult {
  surface: Surface;
  suite: string | null;
  suiteOutcome: SuiteOutcome;
  totalRows: number;
  conformingRows: number; // registry status === 'conforms'
  expectedGreenRows: number; // registry status in REGRESSION_STATUSES
  greenRows: number; // live: rows whose assertion set passed
  redRows: number; // live: rows whose assertion set failed
  unmappedRows: number; // live: rows with no assertion set yet
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
  /** Testcases that matched no row id (e.g. the suite's completeness gate). */
  unkeyedTests: number;
  unkeyedFailures: number;
  rows: RowResult[];
  regressions: RowResult[];
  /** Expected-green rows with no assertion set — drift, reported not gated. */
  unguarded: RowResult[];
  /** Green rows not yet flipped to conforms — flip candidates (healthy climb). */
  flipCandidates: RowResult[];
  /**
   * The concerning direction of cdd.md Step 5.3 drift: the registry claims more
   * conforming rows than the suite proves green. Always fully explained by
   * `regressions` (conforms + red) and `unguarded` (conforms + no assertion set),
   * so it is a derived rollup, not a separate signal.
   */
  overclaims: boolean;
  note?: string;
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
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : '';
}

/**
 * Parse the JUnit XML into a flat testcase list. The reporter emits either a
 * self-closing `<testcase ... />` (pass) or `<testcase ...>…<failure/…>…
 * </testcase>` (fail); an `<error>` child is likewise a failure.
 */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[3] ?? '';
    const failed = /<failure\b/.test(inner) || /<error\b/.test(inner);
    cases.push({ name: attr(attrs, 'name'), classname: attr(attrs, 'classname'), passed: !failed });
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

export interface Classification {
  rows: RowResult[];
  greenRows: number;
  redRows: number;
  unmappedRows: number;
  /**
   * Green rows the registry does NOT yet call conforming — assertion sets that
   * pass for rows not yet flipped (cdd.md Step 4 makes the flip a separate
   * reviewed step, so during the climb green routinely runs ahead of conforms).
   * This is the healthy climb direction, reported as informational, never gated.
   */
  flipCandidates: RowResult[];
  regressions: RowResult[];
  unguarded: RowResult[];
  unkeyedTests: number;
  unkeyedFailures: number;
}

/**
 * The pure core of the lane: given the surface's rows and the suite's testcases,
 * map each testcase to the row id(s) it names and decide each row's verdict.
 * Extracted from `evaluateSurface` so the regression rule and the boundary
 * matching are unit-testable without spawning `bun test`.
 */
export function classifyRows(rows: RowInput[], testcases: TestCase[]): Classification {
  const expectedGreen = (status: CompatStatus): boolean => REGRESSION_STATUSES.includes(status);
  const perRow = new Map<string, { tests: number; failed: number }>();
  for (const row of rows) perRow.set(row.id, { tests: 0, failed: 0 });

  let unkeyedTests = 0;
  let unkeyedFailures = 0;
  for (const tc of testcases) {
    const haystack = `${tc.classname} ${tc.name}`;
    const matched = rows.filter((r) => mentionsRow(haystack, r.id));
    if (matched.length === 0) {
      unkeyedTests += 1;
      if (!tc.passed) unkeyedFailures += 1;
      continue;
    }
    for (const row of matched) {
      const agg = perRow.get(row.id)!;
      agg.tests += 1;
      if (!tc.passed) agg.failed += 1;
    }
  }

  const results: RowResult[] = rows.map((r) => {
    const agg = perRow.get(r.id)!;
    const verdict: RowVerdict = agg.tests === 0 ? 'unmapped' : agg.failed > 0 ? 'red' : 'green';
    const eg = expectedGreen(r.status);
    return { id: r.id, status: r.status, expectedGreen: eg, verdict, tests: agg.tests, failed: agg.failed, regressed: eg && verdict === 'red' };
  });

  return {
    rows: results,
    greenRows: results.filter((r) => r.verdict === 'green').length,
    redRows: results.filter((r) => r.verdict === 'red').length,
    unmappedRows: results.filter((r) => r.verdict === 'unmapped').length,
    flipCandidates: results.filter((r) => r.verdict === 'green' && !r.expectedGreen),
    regressions: results.filter((r) => r.regressed),
    unguarded: results.filter((r) => r.expectedGreen && r.verdict === 'unmapped'),
    unkeyedTests,
    unkeyedFailures,
  };
}

function runSuite(suitePath: string, xmlOut: string): { outcome: SuiteOutcome; stderr: string } {
  const result = spawnSync('bun', ['test', suitePath, '--reporter=junit', `--reporter-outfile=${xmlOut}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYRIC_CLIMB: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // bun exits nonzero both when the suite has failing tests (expected here) and
  // when it cannot run at all. The written XML is the discriminator: a suite that
  // ran produces it; a load/compile error produces none.
  if (existsSync(xmlOut)) return { outcome: 'ran', stderr: result.stderr ?? '' };
  return { outcome: 'errored', stderr: result.stderr ?? '' };
}

function evaluateSurface(descriptor: (typeof surfaceDescriptors)[number], tmpDir: string): SurfaceResult {
  const rows = allCompatibilityRows.filter((r) => r.surface === descriptor.surface);
  const suite = descriptor.conformanceSuite ?? null;
  const conformingRows = rows.filter((r) => r.status === 'conforms').length;
  const expectedGreenIds = new Set(rows.filter((r) => REGRESSION_STATUSES.includes(r.status)).map((r) => r.id));

  const base = {
    surface: descriptor.surface,
    suite,
    totalRows: rows.length,
    conformingRows,
    expectedGreenRows: expectedGreenIds.size,
  };

  // No suite path, or the file does not exist yet: red at birth by design. We
  // cannot verify any row, but nothing that should be green is being contradicted
  // — no assertion set failed — so this never gates. It only reports.
  if (!suite || !existsSync(join(REPO_ROOT, suite))) {
    const rowResults: RowResult[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      expectedGreen: expectedGreenIds.has(r.id),
      verdict: 'unmapped',
      tests: 0,
      failed: 0,
      regressed: false,
    }));
    const unguarded = rowResults.filter((r) => r.expectedGreen);
    return {
      ...base,
      suiteOutcome: 'missing',
      greenRows: 0,
      redRows: 0,
      unmappedRows: rows.length,
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
      unkeyedTests: 0,
      unkeyedFailures: 0,
      rows: rowResults,
      regressions: [],
      unguarded,
      flipCandidates: [],
      overclaims: conformingRows !== 0,
      note: suite ? 'suite file not present yet (red at birth)' : 'no conformanceSuite path on descriptor',
    };
  }

  const xmlOut = join(tmpDir, `${descriptor.surface}.xml`);
  const { outcome, stderr } = runSuite(suite, xmlOut);

  if (outcome === 'errored') {
    // The suite exists but could not run (import/compile error). It verified
    // nothing. Per the strict regression rule ("a failing assertion set"), an
    // assertion set that never executed did not fail, so this reports rather than
    // gates — but a suite that cannot load while expected-green rows depend on it
    // is loud drift, surfaced in `unguarded` and the note.
    const rowResults: RowResult[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      expectedGreen: expectedGreenIds.has(r.id),
      verdict: 'unmapped',
      tests: 0,
      failed: 0,
      regressed: false,
    }));
    return {
      ...base,
      suiteOutcome: 'errored',
      greenRows: 0,
      redRows: 0,
      unmappedRows: rows.length,
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
      unkeyedTests: 0,
      unkeyedFailures: 0,
      rows: rowResults,
      regressions: [],
      unguarded: rowResults.filter((r) => r.expectedGreen),
      flipCandidates: [],
      overclaims: conformingRows !== 0,
      note: `suite failed to run (no test output produced)${stderr ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
    };
  }

  const testcases = parseJUnit(readFileSync(xmlOut, 'utf8'));
  const classified = classifyRows(rows, testcases);
  const { greenRows, redRows, unmappedRows, regressions, unguarded } = classified;
  const testsTotal = testcases.length;
  const testsFailed = testcases.filter((t) => !t.passed).length;

  return {
    ...base,
    suiteOutcome: 'ran',
    greenRows,
    redRows,
    unmappedRows,
    testsTotal,
    testsPassed: testsTotal - testsFailed,
    testsFailed,
    unkeyedTests: classified.unkeyedTests,
    unkeyedFailures: classified.unkeyedFailures,
    rows: classified.rows,
    regressions,
    unguarded,
    flipCandidates: classified.flipCandidates,
    // The concerning cdd.md Step 5.3 direction only: registry conforms exceeds
    // live green. Green exceeding conforms is the healthy climb (flipCandidates).
    overclaims: conformingRows > greenRows,
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function main(): void {
  const wantJson = process.argv.includes('--json');
  const climbDescriptors = surfaceDescriptors.filter((d) => d.climb);

  const tmpDir = mkdtempSync(join(tmpdir(), 'pyric-climb-'));
  let results: SurfaceResult[];
  try {
    results = climbDescriptors.map((d) => evaluateSurface(d, tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const regressed = results.filter((r) => r.regressions.length > 0);
  const exitCode = regressed.length > 0 ? 1 : 0;

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          exitCode,
          regressionRule: `exit nonzero iff a row with registry status in [${REGRESSION_STATUSES.join(', ')}] has a failing assertion set`,
          surfaces: results.map((r) => ({
            surface: r.surface,
            suite: r.suite,
            suiteOutcome: r.suiteOutcome,
            totalRows: r.totalRows,
            conformingRows: r.conformingRows,
            expectedGreenRows: r.expectedGreenRows,
            greenRows: r.greenRows,
            redRows: r.redRows,
            unmappedRows: r.unmappedRows,
            liveGreenRatePct: pct(r.greenRows, r.totalRows),
            registryConformingRatePct: pct(r.conformingRows, r.totalRows),
            flipCandidates: r.flipCandidates.map((row) => ({ id: row.id, status: row.status })),
            overclaims: r.overclaims,
            tests: { total: r.testsTotal, passed: r.testsPassed, failed: r.testsFailed, unkeyed: r.unkeyedTests, unkeyedFailures: r.unkeyedFailures },
            regressions: r.regressions.map((row) => ({ id: row.id, status: row.status, tests: row.tests, failed: row.failed })),
            unguarded: r.unguarded.map((row) => ({ id: row.id, status: row.status })),
            rows: r.rows.map((row) => ({ id: row.id, status: row.status, verdict: row.verdict, tests: row.tests, failed: row.failed })),
            note: r.note,
          })),
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }

  console.log('# Climb lane\n');
  console.log('On-demand CDD climb report (docs/conformance/cdd.md Step 5). Non-blocking:');
  console.log('this lane is NOT a required check; it turns red only on a green-row regression.\n');

  if (climbDescriptors.length === 0) {
    console.log('No surfaces are marked `climb: true`. Nothing to climb.');
    process.exit(0);
  }

  for (const r of results) {
    console.log(`## ${r.surface}`);
    console.log(`suite: ${r.suite ? repoRel(join(REPO_ROOT, r.suite)) : '(none)'}`);
    const outcomeLabel =
      r.suiteOutcome === 'ran' ? 'ran' : r.suiteOutcome === 'missing' ? 'not present yet' : 'FAILED TO RUN';
    console.log(`suite status: ${outcomeLabel}${r.note ? ` — ${r.note}` : ''}`);
    console.log(`live green rows: ${r.greenRows}/${r.totalRows} (${pct(r.greenRows, r.totalRows)}%)`);
    console.log(`registry conforming: ${r.conformingRows}/${r.totalRows} (${pct(r.conformingRows, r.totalRows)}%)`);
    if (r.suiteOutcome === 'ran') {
      console.log(`assertion sets: ${r.greenRows} green, ${r.redRows} red, ${r.unmappedRows} unmapped`);
      console.log(`raw tests: ${r.testsPassed}/${r.testsTotal} passed` + (r.unkeyedTests ? `; ${r.unkeyedTests} unkeyed (${r.unkeyedFailures} failing)` : ''));
    }
    if (r.flipCandidates.length > 0) {
      console.log(
        `flip candidates: ${r.flipCandidates.length} assertion set(s) passing for rows not yet flipped to conforms (cdd.md Step 4) — ${r.flipCandidates.map((x) => x.id).join(', ')}`,
      );
    }
    if (r.overclaims) {
      console.log(
        `DRIFT: registry claims more conforming rows (${r.conformingRows}) than the suite proves green (${r.greenRows}); see regressions/unguarded below (cdd.md Step 5.3).`,
      );
    }
    if (r.unguarded.length > 0) {
      console.log(`WARNING: ${r.unguarded.length} expected-green row(s) have no assertion set: ${r.unguarded.map((x) => x.id).join(', ')}`);
    }
    if (r.regressions.length > 0) {
      console.log(`REGRESSION — previously-green rows now red:`);
      for (const row of r.regressions) console.log(`  ✗ ${row.id} (${row.status}): ${row.failed}/${row.tests} assertions failing`);
    } else {
      console.log('regressions: none');
    }
    console.log('');
  }

  if (exitCode === 0) {
    console.log('✓ No green-row regressions. Red among unverified rows is the expected climb.');
  } else {
    const ids = regressed.flatMap((r) => r.regressions.map((row) => `${r.surface}:${row.id}`));
    console.log(`✗ Green-row regression(s): ${ids.join(', ')}. Halt further row flips and fix-forward (cdd.md resolved decision #2).`);
  }
  process.exit(exitCode);
}

if (import.meta.main) main();
