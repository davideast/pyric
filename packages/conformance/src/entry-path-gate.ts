#!/usr/bin/env bun
/**
 * The entry-path CLIFF gate.
 *
 * Runs every `entry-path/<name>.ts` corpus program IN-PROCESS (import,
 * initialize, one real operation, assert) and is a hard CLIFF, not a
 * ratchet — the one ratified exception to this repo's usual
 * regression-only-gate philosophy (see `coverage.ts`'s header for the
 * ratchet norm this deliberately breaks from). The entry-path class of bug —
 * initialization itself fails — is total and immediate for a user, so there
 * is no tolerated baseline the way `census-gate.ts` tolerates existing
 * UNMAPPED debt: a program either passes, or its failure is an ALREADY-
 * ACKNOWLEDGED gap cited in `entry-path/expected-failures.ts`, or the gate
 * fails the build.
 *
 * Per program, one of:
 *   - GREEN            — `run()` completed without throwing.
 *   - RED-KNOWN         — `run()` threw, AND `expected-failures.ts` has a
 *                         record for this program. Exit 0 contribution; the
 *                         failure + its citation are printed so the report
 *                         stays honest about what's actually broken today.
 *   - RED               — `run()` threw and there is no expected-failure
 *                         record. Fatal.
 *   - STALE EXPECTED-FAILURE — `run()` PASSED despite an expected-failure
 *                         record existing for this program. Also fatal — a
 *                         citation that no longer describes reality must be
 *                         deleted (`expected-failures.ts`'s header), not left
 *                         to silently keep tolerating a program CI would
 *                         otherwise hold to green.
 *
 * `entry-path-validate.ts` (wired into `compat:validate`) is the SEPARATE
 * check that every `expected-failures.ts` record cites a real, currently-
 * existing gap (an unmapped census symbol, a deferred deny-list entry, or an
 * unverified registry row) — this gate does not re-derive that; it only
 * flags a record naming a program that does not exist, and otherwise trusts
 * the record's citation is valid (`compat:validate` runs the real check, and
 * both are chained in `compat:check`).
 *
 * Usage:
 *   bun run compat:entry-path            # human report (CI: compat:check)
 *   bun run compat:entry-path --json     # machine JSON, no console table
 *
 * Exit codes: 0 every program is GREEN or RED-KNOWN. 1 any program is RED
 * (uncited failure), any expected-failure record is now STALE (its program
 * actually passed), or an expected-failure record names a program that does
 * not exist in the corpus.
 */
import 'fake-indexeddb/auto';
import { loadEntryPathPrograms } from '../entry-path/load.ts';
import { expectedFailures } from '../entry-path/expected-failures.ts';
import type { ExpectedFailureRecord } from '../entry-path/types.ts';
import { getApps, deleteApp } from 'pyric/app';

export type ProgramVerdict = 'green' | 'red-known' | 'red' | 'stale-expected-failure';

export interface EntryPathProgramResult {
  program: string;
  verdict: ProgramVerdict;
  /** The thrown error's message (import error or op/assertion error), if any. */
  error?: string;
  expectedFailure?: ExpectedFailureRecord;
}

export interface EntryPathReport {
  generatedAt: string;
  results: EntryPathProgramResult[];
  /** Expected-failure records naming a program that does not exist in the
   *  corpus — always fatal, reported separately from per-program results. */
  unknownProgramCitations: string[];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

export async function runEntryPathGate(): Promise<EntryPathReport> {
  const programs = await loadEntryPathPrograms();
  const programNames = new Set(programs.map((p) => p.name));
  const expectedByProgram = new Map(expectedFailures.map((r) => [r.program, r]));

  const unknownProgramCitations = expectedFailures
    .filter((r) => !programNames.has(r.program))
    .map((r) => r.program);

  const results: EntryPathProgramResult[] = [];
  for (const program of programs) {
    // Program isolation: each quickstart program assumes a fresh process and
    // initializes the [DEFAULT] app. Faithful duplicate-app semantics (the app
    // surface climb) make a second default-name initializeApp throw, so the
    // harness clears the registry between programs — using the mirrored
    // getApps/deleteApp themselves. Programs stay pure quickstart shape.
    await Promise.all(getApps().map((app) => deleteApp(app)));
    const expectedFailure = expectedByProgram.get(program.name);
    try {
      await program.run();
      results.push(
        expectedFailure
          ? { program: program.name, verdict: 'stale-expected-failure', expectedFailure }
          : { program: program.name, verdict: 'green' },
      );
    } catch (err) {
      const error = errorMessage(err);
      results.push(
        expectedFailure
          ? { program: program.name, verdict: 'red-known', error, expectedFailure }
          : { program: program.name, verdict: 'red', error },
      );
    }
  }

  return { generatedAt: new Date().toISOString(), results, unknownProgramCitations };
}

export function entryPathGateExitCode(report: EntryPathReport): number {
  if (report.unknownProgramCitations.length > 0) return 1;
  return report.results.some((r) => r.verdict === 'red' || r.verdict === 'stale-expected-failure') ? 1 : 0;
}

function printReport(report: EntryPathReport): void {
  console.log('# Entry-path conformance (CLIFF gate)\n');
  console.log('Every program: import from pyric subpaths as a user would -> initialize -> configure -> one real operation -> assert it succeeded. No baseline, no tolerance — see entry-path-gate.ts header.\n');

  for (const result of report.results) {
    if (result.verdict === 'green') {
      console.log(`  GREEN       ${result.program}`);
    } else if (result.verdict === 'red-known') {
      console.log(`  RED-KNOWN   ${result.program}`);
      console.log(`              reason:  ${result.expectedFailure!.reason}`);
      console.log(`              fixedBy: ${result.expectedFailure!.fixedBy}`);
      console.log(`              error:   ${result.error?.split('\n')[0]}`);
    } else if (result.verdict === 'red') {
      console.error(`  RED         ${result.program}`);
      console.error(`              ${result.error}`);
    } else {
      console.error(`  STALE       ${result.program}: expected-failures.ts has a record for this program, but run() PASSED.`);
      console.error(`              Delete this record from entry-path/expected-failures.ts: ${JSON.stringify(result.expectedFailure)}`);
    }
  }

  if (report.unknownProgramCitations.length > 0) {
    console.error(`\n✗ expected-failures.ts cites unknown program(s): ${report.unknownProgramCitations.join(', ')} (no matching entry-path/<name>.ts)`);
  }

  const green = report.results.filter((r) => r.verdict === 'green').length;
  const redKnown = report.results.filter((r) => r.verdict === 'red-known').length;
  const red = report.results.filter((r) => r.verdict === 'red').length;
  const stale = report.results.filter((r) => r.verdict === 'stale-expected-failure').length;
  console.log(`\n${green} green, ${redKnown} red-known, ${red} red, ${stale} stale-expected-failure — ${report.results.length} program(s) total.`);

  if (entryPathGateExitCode(report) === 0) {
    console.log('\n✓ Entry-path gate clean (every program green or red-known-with-citation).');
  } else {
    console.error('\n✗ Entry-path gate FAILED — see RED / STALE / unknown-citation entries above.');
  }
}

if (import.meta.main) {
  const report = await runEntryPathGate();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exit(entryPathGateExitCode(report));
}
