#!/usr/bin/env bun
/**
 * Entry-path critical-set + expected-failure citation validation.
 *
 * Two fatal checks, both consumed by `validate-registry.ts` (`compat:validate`)
 * so a bad citation blocks the build the same way any other registry
 * integrity problem does:
 *
 *  1. CRITICAL SYMBOLS (derived on demand from the entry-path programs by
 *     `entry-path-symbols.ts`) — every symbol the entry-path corpus imports
 *     from a `pyric/*` package that maps to a census surface must be
 *     census-MAPPED right now, or covered by an `expected-failures.ts` record
 *     naming that exact surface + symbol for a program that actually imports
 *     it. A critical symbol that is neither is a gap NOBODY has
 *     acknowledged — fatal.
 *
 *  2. EXPECTED-FAILURE CITATIONS — every `expected-failures.ts` record's
 *     `gap` must resolve to a REAL, CURRENTLY-EXISTING gap: an UNMAPPED
 *     census symbol, a `'deferred'` surface disposition, or a registry row
 *     whose status is currently `'unverified'`. A citation naming something
 *     already fixed (or that never existed) is exactly the staleness this
 *     gate exists to catch — fatal, forcing the record's deletion (see
 *     `expected-failures.ts`'s header).
 *
 * Both checks are pure functions over already-computed inputs (no I/O of
 * their own beyond what callers pass in) so tests can exercise the citation
 * rules without shelling out to the census or touching the real ledger.
 */
import type { CensusSurface } from '../surfaces/types.ts';
import type { ExpectedFailureRecord } from '../entry-path/types.ts';
import type { CriticalSymbolsReport } from './entry-path-symbols.ts';

export interface EntryPathCensusRow {
  surface: CensusSurface;
  mirrors: string[];
  runtime: {
    mapped: string[];
    unmapped: string[];
    dispositioned: Array<{ symbol: string; availability: string }>;
  };
}

export interface EntryPathValidationInput {
  criticalSymbols: CriticalSymbolsReport;
  expectedFailures: ExpectedFailureRecord[];
  census: EntryPathCensusRow[];
  /** rowId -> current registry status, from the ledger. */
  ledgerRowStatuses: Map<string, string>;
  /** Every real entry-path program name (`entry-path/<name>.ts`), for the
   *  "does this expected-failure name a real program" check. */
  programNames: string[];
}

/**
 * `pyric/*` package specifier -> census surface, derived from the surface
 * central model census' own `mirrors` lists — never hardcoded and never
 * reloaded from the authored contracts by this consumer.
 */
export function packageToCensusSurface(census: readonly EntryPathCensusRow[]): Map<string, CensusSurface> {
  const map = new Map<string, CensusSurface>();
  for (const entry of census) {
    for (const mirror of entry.mirrors) map.set(mirror, entry.surface);
  }
  return map;
}

export function validateEntryPath(input: EntryPathValidationInput): string[] {
  const problems: string[] = [];
  const packageSurface = packageToCensusSurface(input.census);
  const censusBySurface = new Map(input.census.map((c) => [c.surface, c]));

  // ── Expected-failure structural integrity + citation validity ─────────
  const seenPrograms = new Set<string>();
  for (const record of input.expectedFailures) {
    const where = `entry-path/expected-failures.ts (program '${record.program}')`;

    if (!record.program?.trim()) {
      problems.push(`${where}: missing program`);
    } else {
      if (seenPrograms.has(record.program)) problems.push(`${where}: duplicate expected-failure record for the same program`);
      seenPrograms.add(record.program);
      if (!input.programNames.includes(record.program)) problems.push(`${where}: no entry-path program named '${record.program}' exists`);
    }
    if (!record.reason?.trim()) problems.push(`${where}: missing reason`);
    if (!record.fixedBy?.trim()) problems.push(`${where}: missing fixedBy`);

    const gap = record.gap;
    if (!gap) {
      problems.push(`${where}: missing gap citation`);
      continue;
    }
    if (gap.kind === 'unmapped-symbol') {
      const census = censusBySurface.get(gap.surface);
      if (!census) {
        problems.push(`${where}: cites unknown census surface '${gap.surface}'`);
      } else if (!census.runtime.unmapped.includes(gap.symbol)) {
        problems.push(
          `${where}: cites '${gap.symbol}' as UNMAPPED on surface '${gap.surface}', but it is not currently unmapped — stale citation, delete this record`,
        );
      }
    } else if (gap.kind === 'disposition-deferred') {
      const tier = censusBySurface.get(gap.surface)?.runtime.dispositioned
        .find(({ symbol }) => symbol === gap.symbol)?.availability;
      if (tier !== 'deferred') {
        problems.push(
          `${where}: cites '${gap.symbol}' on surface '${gap.surface}' as deferred, but no such surface disposition currently exists — stale citation, delete this record`,
        );
      }
    } else if (gap.kind === 'unverified-row') {
      const status = input.ledgerRowStatuses.get(gap.rowId);
      if (status !== 'unverified') {
        problems.push(
          `${where}: cites registry row '${gap.rowId}' as unverified, but its current status is ${status ?? 'MISSING'} — stale citation, delete this record`,
        );
      }
    } else {
      problems.push(`${where}: unknown gap citation kind '${(gap as { kind?: string }).kind}'`);
    }
  }

  // ── Critical symbols: census-mapped, or covered by a valid citation ────
  for (const [specifier, entry] of Object.entries(input.criticalSymbols.packages)) {
    const surface = packageSurface.get(specifier);
    if (!surface) continue; // e.g. pyric/sandbox — no upstream census surface; out of scope.
    const census = censusBySurface.get(surface);
    if (!census) {
      problems.push(`entry-path critical symbols: package '${specifier}' maps to unknown census surface '${surface}'`);
      continue;
    }
    for (const symbol of entry.symbols) {
      if (census.runtime.mapped.includes(symbol)) continue;
      const citingRecord = input.expectedFailures.find(
        (r) =>
          entry.programs.includes(r.program) &&
          ((r.gap.kind === 'unmapped-symbol' && r.gap.surface === surface && r.gap.symbol === symbol) ||
            (r.gap.kind === 'disposition-deferred' && r.gap.surface === surface && r.gap.symbol === symbol)),
      );
      if (!citingRecord) {
        problems.push(
          `entry-path critical symbol '${symbol}' (package '${specifier}', surface '${surface}', used by program(s): ${entry.programs.join(', ')}) is not census-mapped and has no expected-failure citation`,
        );
      }
    }
  }

  return problems;
}
