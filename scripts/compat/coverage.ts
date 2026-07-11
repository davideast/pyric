#!/usr/bin/env bun
/**
 * Compatibility coverage — the published, tracked, regression-guarded number.
 *
 * Combines two axes that scripts/compat/surface-census.ts and
 * scripts/compat/ledger.ts already compute, per COMPAT service:
 *
 *   SURFACE coverage   = mirrored SDK exports / SDK exports (surface-census).
 *   BEHAVIOR conformance = `conforms` registry rows / evaluated rows (ledger).
 *
 * Each axis is reported on two scopes:
 *   total    — over every export / row, no exclusions.
 *   intended — total minus what is DELIBERATELY out of scope (surface
 *              deny-list entries for surface coverage; `status: 'unsupported'`
 *              rows for behavior conformance). This is the honest "does the
 *              thing pyric claims to support actually work" denominator.
 *
 * The HEADLINE metric is total-INTENDED SURFACE coverage per service — "will
 * my app's calls exist against the mirror." Behavior conformance is the
 * second line: "and if they exist, do they behave like prod."
 *
 * `diverged-documented` and `unverified` rows are broken out separately and
 * are NEVER folded into `conforms` — doing so would be exactly the kind of
 * relabeling-to-game-the-number this script exists to prevent.
 *
 * Usage:
 *   bun run compat:coverage                    # human table + regression check (CI)
 *   bun run compat:coverage --json              # machine JSON only, no regression check
 *   bun run compat:coverage --update-baseline   # recompute and overwrite the committed baseline
 *
 * Exit codes: 0 clean / baseline updated, 1 a regression was found vs. the
 * committed baseline (coverage-baseline.json). NEVER fails on an absolute
 * percentage threshold — see the design note at the bottom of this file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CensusSurface } from './surface-denylist.ts';
import { surfaceDescriptors, type Surface } from './registry/index.ts';
import { buildCompatibilityLedger, highRiskUnverifiedRows, type RegistryEntry } from './ledger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CENSUS_SCRIPT = join(HERE, 'surface-census.ts');
const BASELINE_PATH = join(HERE, 'coverage-baseline.json');

// ── Surface census (subprocess — reuses surface-census.ts unmodified) ──────

interface CensusRow {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
  upstreamCount: number;
  mirrorCount: number;
  mapped: string[];
  denied: { symbol: string; reason: string }[];
  unmapped: string[];
  extra: string[];
}

function runCensus(): CensusRow[] {
  // surface-census.ts exits 1 when there are UNMAPPED gaps; that's not a
  // coverage.ts failure (surface coverage < 100% is expected and reported,
  // not fatal), so tolerate a non-zero exit and just read stdout.
  let out: string;
  try {
    out = execFileSync('bun', ['run', CENSUS_SCRIPT, '--json'], { encoding: 'utf8', cwd: REPO_ROOT });
  } catch (err) {
    const e = err as { stdout?: string };
    if (!e.stdout) throw err;
    out = e.stdout;
  }
  return (JSON.parse(out) as { surfaces: CensusRow[] }).surfaces;
}

/** The five COMPAT services this coverage report tracks — no `app` (no COMPAT matrix, would break behavior-axis parity). */
const SERVICES: Surface[] = ['auth', 'firestore', 'rtdb', 'rtdb-modular', 'storage'];

/** Each COMPAT service's underlying surface-census surface. `rtdb` and `rtdb-modular` share the `database` census — surface-census.ts does not distinguish the classic vs modular database API at the export level, so both report the same measurement (flagged below). */
const CENSUS_SURFACE_FOR: Record<Surface, CensusSurface> = {
  auth: 'auth',
  firestore: 'firestore',
  rtdb: 'database',
  'rtdb-modular': 'database',
  storage: 'storage',
};

interface SurfaceCoverage {
  mapped: number;
  total: { denominator: number; pct: number };
  intended: { denominator: number; pct: number };
}

function surfaceCoverageFor(census: CensusRow): SurfaceCoverage {
  const mapped = census.mapped.length;
  const totalDenominator = census.upstreamCount;
  const intendedDenominator = census.upstreamCount - census.denied.length;
  return {
    mapped,
    total: { denominator: totalDenominator, pct: pct(mapped, totalDenominator) },
    intended: { denominator: intendedDenominator, pct: pct(mapped, intendedDenominator) },
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

// ── Behavior conformance (ledger.ts — unmodified) ──────────────────────────

interface BehaviorConformance {
  conforms: number;
  divergedDocumented: number;
  bug: number;
  unsupported: number;
  unverified: number;
  total: { denominator: number; pct: number };
  intended: { denominator: number; pct: number };
}

function behaviorConformanceFor(rows: RegistryEntry[]): BehaviorConformance {
  const conforms = rows.filter((r) => r.status === 'conforms').length;
  const divergedDocumented = rows.filter((r) => r.status === 'diverged-documented').length;
  const bug = rows.filter((r) => r.status === 'bug').length;
  const unsupported = rows.filter((r) => r.status === 'unsupported').length;
  const unverified = rows.filter((r) => r.status === 'unverified').length;
  const totalDenominator = rows.length;
  const intendedDenominator = totalDenominator - unsupported;
  return {
    conforms,
    divergedDocumented,
    bug,
    unsupported,
    unverified,
    total: { denominator: totalDenominator, pct: pct(conforms, totalDenominator) },
    intended: { denominator: intendedDenominator, pct: pct(conforms, intendedDenominator) },
  };
}

// ── Combined per-service + overall coverage ─────────────────────────────────

interface ServiceCoverage {
  surface: Surface;
  censusSurface: CensusSurface;
  sharedCensus: boolean;
  surfaceCoverage: SurfaceCoverage;
  behavior: BehaviorConformance;
}

export interface CoverageReport {
  generatedAt: string;
  services: ServiceCoverage[];
  overall: {
    surfaceCoverage: SurfaceCoverage;
    behavior: BehaviorConformance;
  };
  orphanObservations: string[];
  highRiskUnverified: string[];
  /** rowId -> status, for the per-row regression check (a row flipping OFF conforms). */
  rowStatuses: Record<string, string>;
}

function buildReport(): CoverageReport {
  const censuses = runCensus();
  const censusBySurface = new Map(censuses.map((c) => [c.surface, c]));
  const ledger = buildCompatibilityLedger();

  const services: ServiceCoverage[] = SERVICES.map((surface) => {
    const censusSurface = CENSUS_SURFACE_FOR[surface];
    const census = censusBySurface.get(censusSurface);
    if (!census) throw new Error(`No surface census entry for '${censusSurface}' (service '${surface}')`);
    const rows = ledger.entries.filter((r) => r.surface === surface);
    return {
      surface,
      censusSurface,
      sharedCensus: surface === 'rtdb' || surface === 'rtdb-modular',
      surfaceCoverage: surfaceCoverageFor(census),
      behavior: behaviorConformanceFor(rows),
    };
  });

  // Overall surface coverage: sum each UNIQUE census surface once (rtdb +
  // rtdb-modular share the `database` census — do not double-count it).
  const uniqueCensusSurfaces = new Set(SERVICES.map((s) => CENSUS_SURFACE_FOR[s]));
  let mapped = 0, totalDen = 0, intendedDen = 0;
  for (const cs of uniqueCensusSurfaces) {
    const census = censusBySurface.get(cs)!;
    const c = surfaceCoverageFor(census);
    mapped += c.mapped;
    totalDen += c.total.denominator;
    intendedDen += c.intended.denominator;
  }
  const overallSurface: SurfaceCoverage = {
    mapped,
    total: { denominator: totalDen, pct: pct(mapped, totalDen) },
    intended: { denominator: intendedDen, pct: pct(mapped, intendedDen) },
  };

  // Overall behavior: every row across the five services (no double counting — rtdb and rtdb-modular are distinct row sets).
  const allServiceRows = ledger.entries.filter((r) => SERVICES.includes(r.surface));
  const overallBehavior = behaviorConformanceFor(allServiceRows);

  const highRisk = highRiskUnverifiedRows(ledger).map((r) => r.id);
  const rowStatuses: Record<string, string> = {};
  for (const r of ledger.entries) rowStatuses[r.id] = r.status;

  return {
    generatedAt: new Date().toISOString(),
    services,
    overall: { surfaceCoverage: overallSurface, behavior: overallBehavior },
    orphanObservations: ledger.orphanObservations.map((o) => o.name),
    highRiskUnverified: highRisk,
    rowStatuses,
  };
}

// ── Human table ──────────────────────────────────────────────────────────

function printTable(report: CoverageReport): void {
  console.log('# Compatibility coverage\n');
  console.log('Surface coverage = mirrored SDK exports / SDK exports. Behavior conformance = `conforms` rows / evaluated rows.');
  console.log('`intended` excludes what is deliberately out of scope (deny-listed exports; `unsupported` rows). HEADLINE = total-intended surface coverage.\n');

  const header = 'service        surface(total)  surface(intended)  behavior(total)  behavior(intended)  diverged  unverified';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of report.services) {
    const note = s.sharedCensus ? '*' : ' ';
    console.log(
      [
        (s.surface + note).padEnd(15),
        `${s.surfaceCoverage.total.pct}%`.padStart(14),
        `${s.surfaceCoverage.intended.pct}%`.padStart(18),
        `${s.behavior.total.pct}%`.padStart(16),
        `${s.behavior.intended.pct}%`.padStart(19),
        String(s.behavior.divergedDocumented).padStart(9),
        String(s.behavior.unverified).padStart(11),
      ].join('  '),
    );
  }
  console.log('-'.repeat(header.length));
  console.log(
    [
      'OVERALL'.padEnd(15),
      `${report.overall.surfaceCoverage.total.pct}%`.padStart(14),
      `${report.overall.surfaceCoverage.intended.pct}%`.padStart(18),
      `${report.overall.behavior.total.pct}%`.padStart(16),
      `${report.overall.behavior.intended.pct}%`.padStart(19),
      String(report.overall.behavior.divergedDocumented).padStart(9),
      String(report.overall.behavior.unverified).padStart(11),
    ].join('  '),
  );
  console.log('\n* rtdb and rtdb-modular share one surface-census measurement (`database`) — surface-census.ts does not distinguish the classic vs modular export sets.');
  console.log(`\nHigh-risk unverified conforms rows: ${report.highRiskUnverified.length}`);
  console.log(`Orphan observations: ${report.orphanObservations.length}`);
}

// ── Baseline + regression gate ──────────────────────────────────────────────

interface Baseline {
  generatedAt: string;
  services: Record<string, { surfaceCoveragePct: { total: number; intended: number } }>;
  overall: { surfaceCoveragePct: { total: number; intended: number } };
  rowStatuses: Record<string, string>;
  highRiskUnverified: string[];
  orphanObservations: string[];
}

function toBaseline(report: CoverageReport): Baseline {
  return {
    generatedAt: report.generatedAt,
    services: Object.fromEntries(
      report.services.map((s) => [s.surface, { surfaceCoveragePct: { total: s.surfaceCoverage.total.pct, intended: s.surfaceCoverage.intended.pct } }]),
    ),
    overall: { surfaceCoveragePct: { total: report.overall.surfaceCoverage.total.pct, intended: report.overall.surfaceCoverage.intended.pct } },
    rowStatuses: report.rowStatuses,
    highRiskUnverified: report.highRiskUnverified,
    orphanObservations: report.orphanObservations,
  };
}

/**
 * Regression-only gate. Deliberately does NOT fail on an absolute percentage
 * — a threshold gate invites relabeling rows `conforms` just to clear the
 * bar, which is the exact dishonesty this ratchet exists to prevent. It only
 * fails when something that WAS true stops being true:
 *   - a row that was `conforms` is no longer `conforms`,
 *   - a service's surface coverage % drops,
 *   - a NEW orphan observation appears,
 *   - the high-risk-unverified count increases.
 */
function findRegressions(baseline: Baseline, report: CoverageReport): string[] {
  const problems: string[] = [];

  for (const s of report.services) {
    const base = baseline.services[s.surface];
    if (!base) continue;
    if (s.surfaceCoverage.total.pct < base.surfaceCoveragePct.total) {
      problems.push(`${s.surface}: surface coverage (total) dropped ${base.surfaceCoveragePct.total}% -> ${s.surfaceCoverage.total.pct}%`);
    }
    if (s.surfaceCoverage.intended.pct < base.surfaceCoveragePct.intended) {
      problems.push(`${s.surface}: surface coverage (intended) dropped ${base.surfaceCoveragePct.intended}% -> ${s.surfaceCoverage.intended.pct}%`);
    }
  }
  if (report.overall.surfaceCoverage.total.pct < baseline.overall.surfaceCoveragePct.total) {
    problems.push(`overall: surface coverage (total) dropped ${baseline.overall.surfaceCoveragePct.total}% -> ${report.overall.surfaceCoverage.total.pct}%`);
  }
  if (report.overall.surfaceCoverage.intended.pct < baseline.overall.surfaceCoveragePct.intended) {
    problems.push(`overall: surface coverage (intended) dropped ${baseline.overall.surfaceCoveragePct.intended}% -> ${report.overall.surfaceCoverage.intended.pct}%`);
  }

  const CONFORMING_DEMOTION = new Set(['bug', 'diverged-documented', 'unverified', 'unsupported']);
  for (const [id, prevStatus] of Object.entries(baseline.rowStatuses)) {
    if (prevStatus !== 'conforms') continue;
    const currentStatus = report.rowStatuses[id];
    if (currentStatus === undefined) {
      problems.push(`${id}: was 'conforms', row removed from the registry`);
    } else if (CONFORMING_DEMOTION.has(currentStatus)) {
      problems.push(`${id}: was 'conforms', now '${currentStatus}'`);
    }
  }

  const baselineOrphans = new Set(baseline.orphanObservations);
  const newOrphans = report.orphanObservations.filter((o) => !baselineOrphans.has(o));
  if (newOrphans.length > 0) problems.push(`${newOrphans.length} NEW orphan observation(s): ${newOrphans.join(', ')}`);

  if (report.highRiskUnverified.length > baseline.highRiskUnverified.length) {
    problems.push(`high-risk unverified rows increased: ${baseline.highRiskUnverified.length} -> ${report.highRiskUnverified.length}`);
  }

  return problems;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const updateBaseline = process.argv.includes('--update-baseline');

  const report = buildReport();

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(toBaseline(report), null, 2) + '\n');
    console.log(`Baseline updated: ${BASELINE_PATH.replace(REPO_ROOT + '/', '')}`);
    console.log(`  overall surface coverage: total ${report.overall.surfaceCoverage.total.pct}%, intended ${report.overall.surfaceCoverage.intended.pct}%`);
    console.log(`  overall behavior conformance: total ${report.overall.behavior.total.pct}%, intended ${report.overall.behavior.intended.pct}%`);
    process.exit(0);
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  printTable(report);

  if (!existsSync(BASELINE_PATH)) {
    console.log('\n! No coverage-baseline.json found — run `bun run compat:coverage --update-baseline` to create one.');
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  const regressions = findRegressions(baseline, report);

  if (regressions.length > 0) {
    console.log(`\n✗ ${regressions.length} regression(s) vs. coverage-baseline.json:`);
    for (const r of regressions) console.log(`  - ${r}`);
    console.log('\nIf this is an intentional change (a legit new diverged/unsupported row, a scoped-down surface), run `bun run compat:coverage --update-baseline` in this PR to accept the new baseline.');
    process.exit(1);
  }

  console.log('\n✓ No regressions vs. coverage-baseline.json.');
  process.exit(0);
}

await main();
