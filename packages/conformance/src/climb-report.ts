import { join } from 'node:path';
import type { CompatStatus, ConformanceDisposition, Surface } from '../registry/index.ts';
import { REPO_ROOT, repoRel } from './ledger.ts';

export type SuiteOutcome = 'ran' | 'missing' | 'errored';
export type RowVerdict = 'green' | 'red' | 'skipped' | 'unmapped';

export interface RowResult {
  id: string;
  status: CompatStatus;
  conformanceDisposition?: ConformanceDisposition;
  expectedGreen: boolean;
  verdict: RowVerdict;
  tests: number;
  failed: number;
  skipped: number;
  /** Expected-green row mapped to a failing or skipped assertion set. */
  regressed: boolean;
}

export interface SurfaceResult {
  surface: Surface;
  suite: string | null;
  suiteOutcome: SuiteOutcome;
  totalRows: number;
  conformingRows: number;
  expectedGreenRows: number;
  greenRows: number;
  redRows: number;
  skippedRows: number;
  unmappedRows: number;
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  /** Testcases that matched no row id (e.g. the suite's completeness gate). */
  unkeyedTests: number;
  unkeyedFailures: number;
  unkeyedSkipped: number;
  rows: RowResult[];
  regressions: RowResult[];
  /** Expected-green rows with no assertion set -- drift, reported not gated. */
  unguarded: RowResult[];
  /** Green rows not yet flipped to conforms -- flip candidates (healthy climb). */
  flipCandidates: RowResult[];
  /**
   * The concerning direction of CDD Steps 5.3 and 6 drift: the registry claims
   * more expected-green rows than the suite proves green.
   */
  overclaims: boolean;
  note?: string;
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

function formatOutcomeLabel(outcome: SuiteOutcome): string {
  if (outcome === 'ran') {
    return 'ran';
  }
  if (outcome === 'missing') {
    return 'not present yet';
  }
  return 'FAILED TO RUN';
}

function formatRegressionDetail(row: RowResult): string {
  if (row.failed > 0 && row.skipped > 0) {
    return `${row.failed}/${row.tests} assertions failing, ${row.skipped}/${row.tests} skipped`;
  }
  if (row.skipped > 0) {
    return `${row.skipped}/${row.tests} assertions skipped`;
  }
  return `${row.failed}/${row.tests} assertions failing`;
}

export function renderClimbJson(
  results: readonly SurfaceResult[],
  exitCode: number,
  regressionStatuses: readonly CompatStatus[],
): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      exitCode,
      regressionRule: `exit nonzero iff a row with registry status in [${regressionStatuses.join(', ')}] has a failing or skipped assertion set`,
      surfaces: results.map((r) => ({
        surface: r.surface,
        suite: r.suite,
        suiteOutcome: r.suiteOutcome,
        totalRows: r.totalRows,
        conformingRows: r.conformingRows,
        expectedGreenRows: r.expectedGreenRows,
        greenRows: r.greenRows,
        redRows: r.redRows,
        skippedRows: r.skippedRows,
        unmappedRows: r.unmappedRows,
        liveGreenRatePct: pct(r.greenRows, r.totalRows),
        registryConformingRatePct: pct(r.conformingRows, r.totalRows),
        flipCandidates: r.flipCandidates.map((row) => ({ id: row.id, status: row.status })),
        overclaims: r.overclaims,
        tests: {
          total: r.testsTotal,
          passed: r.testsPassed,
          failed: r.testsFailed,
          skipped: r.testsSkipped,
          unkeyed: r.unkeyedTests,
          unkeyedFailures: r.unkeyedFailures,
          unkeyedSkipped: r.unkeyedSkipped,
        },
        regressions: r.regressions.map((row) => ({
          id: row.id,
          status: row.status,
          verdict: row.verdict,
          tests: row.tests,
          failed: row.failed,
          skipped: row.skipped,
        })),
        unguarded: r.unguarded.map((row) => ({ id: row.id, status: row.status })),
        rows: r.rows.map((row) => ({
          id: row.id,
          status: row.status,
          verdict: row.verdict,
          tests: row.tests,
          failed: row.failed,
          skipped: row.skipped,
        })),
        note: r.note,
      })),
    },
    null,
    2,
  );
}

export function printClimbConsoleReport(
  results: readonly SurfaceResult[],
  regressed: readonly SurfaceResult[],
  exitCode: number,
): void {
  console.log('# Climb lane\n');
  console.log('On-demand CDD climb report (docs/conformance/cdd.md Step 5). Non-blocking:');
  console.log('this lane is NOT a required check; it turns red only on a green-row regression.\n');

  for (const r of results) {
    console.log(`## ${r.surface}`);
    let suiteLabel = '(none)';
    if (r.suite) {
      suiteLabel = repoRel(join(REPO_ROOT, r.suite));
    }
    console.log(`suite: ${suiteLabel}`);
    const outcomeLabel = formatOutcomeLabel(r.suiteOutcome);
    let noteSuffix = '';
    if (r.note) {
      noteSuffix = ` -- ${r.note}`;
    }
    console.log(`suite status: ${outcomeLabel}${noteSuffix}`);
    console.log(`live green rows: ${r.greenRows}/${r.totalRows} (${pct(r.greenRows, r.totalRows)}%)`);
    console.log(`registry conforming: ${r.conformingRows}/${r.totalRows} (${pct(r.conformingRows, r.totalRows)}%)`);
    if (r.suiteOutcome === 'ran') {
      console.log(
        `assertion sets: ${r.greenRows} green, ${r.redRows} red, ${r.skippedRows} skipped, ${r.unmappedRows} unmapped`,
      );
      let rawLine = `raw tests: ${r.testsPassed}/${r.testsTotal} passed`;
      if (r.testsSkipped > 0) {
        rawLine += `, ${r.testsSkipped} skipped`;
      }
      if (r.unkeyedTests > 0) {
        rawLine += `; ${r.unkeyedTests} unkeyed (${r.unkeyedFailures} failing, ${r.unkeyedSkipped} skipped)`;
      }
      console.log(rawLine);
    }
    if (r.flipCandidates.length > 0) {
      console.log(
        `flip candidates: ${r.flipCandidates.length} assertion set(s) passing for rows not yet flipped to conforms (cdd.md Step 4) -- ${r.flipCandidates.map((x) => x.id).join(', ')}`,
      );
    }
    if (r.overclaims) {
      console.log(
        `DRIFT: registry claims more expected-green rows (${r.expectedGreenRows}) than the suite proves green (${r.greenRows}); see regressions/unguarded below (cdd.md Steps 5.3 and 6).`,
      );
    }
    if (r.unguarded.length > 0) {
      console.log(
        `WARNING: ${r.unguarded.length} expected-green row(s) have no assertion set: ${r.unguarded.map((x) => x.id).join(', ')}`,
      );
    }
    if (r.regressions.length > 0) {
      console.log('REGRESSION -- previously-green rows now red or skipped:');
      for (const row of r.regressions) {
        console.log(`  [FAIL] ${row.id} (${row.status}): ${formatRegressionDetail(row)}`);
      }
    } else {
      console.log('regressions: none');
    }
    console.log('');
  }

  if (exitCode === 0) {
    console.log('[OK] No green-row regressions. Red or skipped among unverified rows is the expected climb.');
  } else {
    const ids = regressed.flatMap((r) => r.regressions.map((row) => `${r.surface}:${row.id}`));
    console.log(
      `[FAIL] Green-row regression(s): ${ids.join(', ')}. Halt further row flips and fix-forward (cdd.md resolved decision #2).`,
    );
  }
}
