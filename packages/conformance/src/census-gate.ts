#!/usr/bin/env bun
/**
 * CI gate over scripts/compat/surface-census.ts.
 *
 * The census produces, per mirror pair (firebase/<x> → pyric/<x>), the set of
 * upstream exports that are neither re-exported by the mirror nor explained
 * by a deny-list entry — UNMAPPED symbols, a genuine surface gap.
 *
 * This gate is a RATCHET, not a cliff. It tolerates the existing UNMAPPED
 * debt recorded in `census-baseline.json` but FAILS the build if a PR
 * introduces a NEW unmapped symbol on any surface (a symbol that was mapped
 * or deny-listed and has regressed to a gap). That keeps surface coverage
 * from silently eroding while letting tracks close the backlog incrementally
 * (drop a symbol from the baseline once it is mirrored or deny-listed).
 *
 * Stale and redundant deny-list entries are a SEPARATE, always-fatal check —
 * there is no baseline tolerance for them. surface-census.ts already exits 1
 * on either, so this gate simply surfaces the same failure with no ratchet:
 * a deny-list entry that denies a symbol no longer upstream, or a symbol
 * that IS mirrored, is decay in the conformance graph itself and must be
 * fixed in scripts/compat/surface-denylist.ts, not tolerated.
 *
 * Usage:
 *   bun run scripts/compat/census-gate.ts            # enforce (CI)
 *   bun run scripts/compat/census-gate.ts --update    # rewrite baseline to current unmapped set
 *
 * Exit codes: 0 clean (unmapped subset of baseline, no stale/redundant
 * denials), 1 a NEW unmapped symbol appeared, or any stale/redundant denial
 * exists.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { CensusSurface } from './surface-denylist.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const BASELINE_PATH = join(HERE, '..', 'baselines', 'census-baseline.json');
const CENSUS_SCRIPT = join(HERE, 'surface-census.ts');

interface CensusRow {
  surface: CensusSurface;
  unmapped: string[];
  staleDenials: string[];
  redundantDenials: string[];
}
interface CensusJson {
  surfaces: CensusRow[];
  totalUnmapped: number;
  totalStaleOrRedundant: number;
}

function runCensus(): CensusJson {
  // surface-census.ts exits 1 whenever there is an UNMAPPED gap or a
  // stale/redundant deny-list entry — that's the expected steady state for
  // this gate to evaluate against the baseline, not a gate failure in
  // itself, so tolerate a non-zero exit and just read stdout (same pattern
  // as scripts/compat/coverage.ts's runCensus()).
  try {
    const out = execFileSync('bun', ['run', CENSUS_SCRIPT, '--json'], { encoding: 'utf8', cwd: REPO_ROOT });
    return JSON.parse(out) as CensusJson;
  } catch (err) {
    const e = err as { stdout?: string };
    if (!e.stdout) throw err;
    return JSON.parse(e.stdout) as CensusJson;
  }
}

interface Baseline {
  _comment: string;
  generatedFrom: string;
  surfaces: Record<string, string[]>;
}

function toBaselineSurfaces(census: CensusJson): Record<string, string[]> {
  return Object.fromEntries(census.surfaces.map((s) => [s.surface, [...s.unmapped].sort()]));
}

const census = runCensus();

const staleOrRedundant = census.surfaces.filter((s) => s.staleDenials.length > 0 || s.redundantDenials.length > 0);

if (process.argv.includes('--update')) {
  const baseline: Baseline = {
    _comment:
      'Baseline of UNMAPPED upstream symbols tolerated by the CI gate (scripts/compat/census-gate.ts), keyed by census surface. The gate fails when a PR introduces a symbol NOT in this list for its surface. To pay down debt: mirror the symbol, or add a deny-list entry with a reason in scripts/compat/surface-denylist.ts, then remove it here. Regenerate with `bun run scripts/compat/census-gate.ts --update`.',
    generatedFrom: 'bun run scripts/compat/surface-census.ts --json',
    surfaces: toBaselineSurfaces(census),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  const total = Object.values(baseline.surfaces).reduce((n, s) => n + s.length, 0);
  console.log(`Baseline updated: ${total} tolerated unmapped symbol(s) across ${Object.keys(baseline.surfaces).length} surface(s).`);
  process.exit(0);
}

console.log('# Compat census gate');

if (staleOrRedundant.length > 0) {
  console.error(`\n✗ ${staleOrRedundant.length} surface(s) with stale or redundant deny-list entries (always fatal, no baseline):`);
  for (const s of staleOrRedundant) {
    if (s.staleDenials.length > 0) console.error(`  - ${s.surface}: stale (not upstream) — ${s.staleDenials.join(', ')}`);
    if (s.redundantDenials.length > 0) console.error(`  - ${s.surface}: redundant (mirrored) — ${s.redundantDenials.join(', ')}`);
  }
  console.error(`\nRemove these entries from scripts/compat/surface-denylist.ts.`);
}

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

let introducedTotal = 0;
let resolvedTotal = 0;
for (const s of census.surfaces) {
  const baselineSet = new Set(baseline.surfaces[s.surface] ?? []);
  const introduced = s.unmapped.filter((sym) => !baselineSet.has(sym));
  const resolved = (baseline.surfaces[s.surface] ?? []).filter((sym) => !s.unmapped.includes(sym));

  if (resolved.length > 0) {
    resolvedTotal += resolved.length;
    console.log(`\n${s.surface}: ${resolved.length} baseline symbol(s) no longer unmapped — the baseline can be tightened, run \`--update\`:`);
    for (const sym of resolved) console.log(`  - ${sym}`);
  }

  if (introduced.length > 0) {
    introducedTotal += introduced.length;
    console.error(`\n✗ ${s.surface}: ${introduced.length} NEW unmapped symbol(s) not in the baseline:`);
    for (const sym of introduced) console.error(`  - ${sym}`);
  }
}

console.log(`\nCurrent unmapped total: ${census.totalUnmapped}. Baseline tolerates ${Object.values(baseline.surfaces).reduce((n, s) => n + s.length, 0)}.`);

if (introducedTotal > 0 || staleOrRedundant.length > 0) {
  console.error(`\nEvery unmapped symbol must be mirrored, deny-listed with a reason, or already tolerated by census-baseline.json. Do not add a NEW gap to the baseline.`);
  process.exit(1);
}

if (resolvedTotal === 0) {
  console.log(`\n✓ No new unmapped symbols, no stale/redundant denials. Gate clean.`);
} else {
  console.log(`\n✓ No new unmapped symbols, no stale/redundant denials. Gate clean (baseline has slack — see above).`);
}
process.exit(0);
