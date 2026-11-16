#!/usr/bin/env bun
/**
 * Compatibility coverage — the published, tracked, regression-guarded number.
 *
 * Combines two axes that packages/conformance/src/surface-census.ts and
 * packages/conformance/src/ledger.ts already compute, per COMPAT service:
 *
 *   PUBLIC RUNTIME surface = mirrored public runtime exports / Firebase public runtime exports.
 *   PUBLIC TYPE surface    = mirrored public type exports / Firebase public type exports.
 *   BEHAVIOR conformance = `conforms` registry rows / evaluated rows (ledger).
 *
 * Public surface has one scope. Leading-underscore Firebase implementation
 * exports are private and never enter it. Deprecated, dispositioned,
 * unsupported, and not-yet-built public APIs remain in the denominator.
 * Behavior retains its total/intended views for now; its five statuses remain
 * visible independently in the registry and generated matrices.
 *
 * Public runtime and type surface answer "will my app's symbol exist against
 * the mirror". Behavior conformance is
 * the FIDELITY of the already-implemented slice — "of the calls that exist,
 * do they behave like prod" — and is never a standalone completeness grade;
 * it says nothing about the calls that don't exist yet.
 *
 * `diverged-documented` and `unverified` rows are broken out separately and
 * are NEVER folded into `conforms` — doing so would be exactly the kind of
 * relabeling-to-game-the-number this script exists to prevent.
 *
 * Usage:
 *   bun run compat:coverage                      # human table only
 *   bun run compat:coverage --json               # machine JSON only, no regression check
 *   bun run compat:coverage --base-report <file> --base-commit <sha> [--report-out <file>]
 *                                                # table + regression check (CI)
 *
 * The regression check compares this commit's report with the base commit's
 * report, so `main` itself is the baseline and nothing is committed. CI
 * restores the base report from the Actions cache, or computes it from a
 * worktree of the base commit (scripts/ci/conformance-gates.sh), and
 * `--report-out` writes this commit's report for the commits built on it.
 *
 * Exit codes: 0 clean, 1 a regression was found vs. the base report. NEVER
 * fails on an absolute percentage threshold (see findRegressions()).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CensusSurface } from '../surfaces/types.ts';
import { type Surface } from '../registry/index.ts';
import { splitConformingRows } from './behavior-split.ts';
import {
  ACCEPTANCES_DIR,
  findRegressions,
  loadAddedAcceptances,
  type CoverageBaseline,
} from './coverage-acceptances.ts';
import { buildCompatibilityLedger, highRiskUnverifiedRows, type RegistryEntry } from './ledger.ts';
import { deriveConformanceModel, type ConformanceModel } from './conformance-model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const ENTRY_PATH_GATE_SCRIPT = join(HERE, 'entry-path-gate.ts');

interface CensusRow {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
  runtime: { upstreamCount: number; mapped: string[] };
  types: { upstreamCount: number; mapped: string[] };
}

// ── Entry-path (surface-census.ts's sibling CLIFF gate — reused, not
// reimplemented) ────────────────────────────────────────────────────────────

/** One program's result, as entry-path-gate.ts --json reports it (subset). */
export interface EntryPathProgramSummary {
  program: string;
  verdict: 'green' | 'red-known' | 'red' | 'stale-expected-failure';
}

function runEntryPathGate(): EntryPathProgramSummary[] {
  // entry-path-gate.ts exits 1 whenever a program is genuinely RED (or an
  // expected-failure has gone stale) — that is a real compat:check failure
  // elsewhere in the chain, not something coverage.ts re-fails on; it just
  // reports the current per-program status honestly.
  let out: string;
  try {
    out = execFileSync('bun', ['run', ENTRY_PATH_GATE_SCRIPT, '--json'], { encoding: 'utf8', cwd: REPO_ROOT });
  } catch (err) {
    const e = err as { stdout?: string };
    if (!e.stdout) throw err;
    out = e.stdout;
  }
  return (JSON.parse(out) as { results: EntryPathProgramSummary[] }).results;
}

/**
 * The COMPAT services this coverage report tracks — every surface descriptor
 * marked `coverage: true`, in descriptor order. That excludes `app` (no COMPAT
 * matrix) and `messaging-admin` (the admin send plane mirrors firebase-admin,
 * which has no runtime export census in this report's scope). See each surface
 * descriptor's `scopeNote` for the per-surface rationale.
 */
/**
 * A MIRROR surface's underlying surface-census surface. Native surfaces have no
 * upstream to census and are absent from this map — the SURFACE (breadth) axis
 * does not apply to them; their completeness is the CLAIMED-API axis instead
 * (published as `native` in the table until the Phase 3 symbol-claims gate
 * lands). `rtdb-modular` is the sole owner of the `database` census now that
 * classic `rtdb` is native.
 */
interface NamespaceCoverage {
  mapped: number;
  denominator: number;
  pct: number;
}

interface SurfaceCoverage {
  runtime: NamespaceCoverage;
  types: NamespaceCoverage;
}

function namespaceCoverage(mapped: number, denominator: number): NamespaceCoverage {
  return { mapped, denominator, pct: pct(mapped, denominator) };
}

function surfaceCoverageFor(census: CensusRow): SurfaceCoverage {
  return {
    runtime: namespaceCoverage(census.runtime.mapped.length, census.runtime.upstreamCount),
    types: namespaceCoverage(census.types.mapped.length, census.types.upstreamCount),
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

// ── Behavior conformance (ledger.ts — unmodified) ──────────────────────────

interface BehaviorSlice {
  denominator: number;
  pct: number;
  captureProvenPct: number;
  selfTestedPct: number;
}

interface BehaviorConformance {
  conforms: number;
  captureProven: number;
  selfTested: number;
  divergedDocumented: number;
  bug: number;
  unsupported: number;
  unverified: number;
  total: BehaviorSlice;
  intended: BehaviorSlice;
}

function behaviorSlice(
  conforms: number,
  captureProven: number,
  selfTested: number,
  denominator: number,
): BehaviorSlice {
  return {
    denominator,
    pct: pct(conforms, denominator),
    captureProvenPct: pct(captureProven, denominator),
    selfTestedPct: pct(selfTested, denominator),
  };
}

function behaviorConformanceFor(rows: RegistryEntry[]): BehaviorConformance {
  const split = splitConformingRows(rows);
  const divergedDocumented = rows.filter((r) => r.status === 'diverged-documented').length;
  const bug = rows.filter((r) => r.status === 'bug').length;
  const unsupported = rows.filter((r) => r.status === 'unsupported').length;
  const unverified = rows.filter((r) => r.status === 'unverified').length;
  const totalDenominator = rows.length;
  const intendedDenominator = totalDenominator - unsupported;
  return {
    conforms: split.conforms,
    captureProven: split.captureProven,
    selfTested: split.selfTested,
    divergedDocumented,
    bug,
    unsupported,
    unverified,
    total: behaviorSlice(split.conforms, split.captureProven, split.selfTested, totalDenominator),
    intended: behaviorSlice(split.conforms, split.captureProven, split.selfTested, intendedDenominator),
  };
}

// ── Combined per-service + overall coverage ─────────────────────────────────

interface ServiceCoverage {
  surface: Surface;
  /** Only mirror surfaces have an upstream export census. */
  kind: 'mirror' | 'native' | 'integration';
  /** The census surface for a mirror service; null for a native one. */
  censusSurface: CensusSurface | null;
  /** SURFACE (breadth) coverage — null for a native surface (no upstream denominator). */
  surfaceCoverage: SurfaceCoverage | null;
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
  /** One line per entry-path corpus program (compat:entry-path — the CLIFF
   *  gate over packages/conformance/entry-path/*.ts), reused here (not
   *  recomputed) so the published coverage surface always shows today's
   *  real green/red-known status. See findRegressions()'s ONE-WAY rule: a
   *  green -> red-known transition is a FAILURE, cliff semantics, not a
   *  ratchet. */
  entryPath: EntryPathProgramSummary[];
}

export function buildReport(
  model: ConformanceModel,
  entryPath: () => EntryPathProgramSummary[] = runEntryPathGate,
): CoverageReport {
  const censuses = model.census;
  const censusBySurface = new Map(censuses.map((c) => [c.surface, c]));
  const ledger = buildCompatibilityLedger(model);
  const descriptors = model.documentation.descriptors;
  const servicesInScope: Surface[] = descriptors.filter((d) => d.coverage).map((d) => d.surface);
  const descriptorFor = new Map(descriptors.map((d) => [d.surface, d]));
  const censusSurfaceFor: Map<Surface, CensusSurface> = new Map(
    descriptors.flatMap((d) => (d.kind === 'mirror' ? [[d.surface, d.censusSurface] as const] : [])),
  );

  const services: ServiceCoverage[] = servicesInScope.map((surface) => {
    const rows = ledger.entries.filter((r) => r.surface === surface);
    const behavior = behaviorConformanceFor(rows);
    const censusSurface = censusSurfaceFor.get(surface);
    // Native surface: no upstream census. Report behavior only; the SURFACE
    // (breadth) column is 'native', not a percentage against a denominator
    // that does not exist.
    if (censusSurface === undefined) {
      const descriptor = descriptorFor.get(surface)!;
      if (descriptor.kind === 'registry-only') {
        throw new Error(`Registry-only surface '${surface}' cannot opt into coverage`);
      }
      return { surface, kind: descriptor.kind, censusSurface: null, surfaceCoverage: null, behavior };
    }
    const census = censusBySurface.get(censusSurface);
    if (!census) throw new Error(`No surface census entry for '${censusSurface}' (service '${surface}')`);
    return { surface, kind: 'mirror', censusSurface, surfaceCoverage: surfaceCoverageFor(census), behavior };
  });

  // Overall surface coverage: sum each UNIQUE census surface once, over MIRROR
  // services only (native surfaces have no upstream breadth to fold in).
  const uniqueCensusSurfaces = new Set(
    servicesInScope.map((s) => censusSurfaceFor.get(s)).filter((cs): cs is CensusSurface => cs !== undefined),
  );
  let runtimeMapped = 0, runtimeDenominator = 0, typeMapped = 0, typeDenominator = 0;
  for (const cs of uniqueCensusSurfaces) {
    const census = censusBySurface.get(cs)!;
    const c = surfaceCoverageFor(census);
    runtimeMapped += c.runtime.mapped;
    runtimeDenominator += c.runtime.denominator;
    typeMapped += c.types.mapped;
    typeDenominator += c.types.denominator;
  }
  const overallSurface: SurfaceCoverage = {
    runtime: namespaceCoverage(runtimeMapped, runtimeDenominator),
    types: namespaceCoverage(typeMapped, typeDenominator),
  };

  // Overall behavior: every row across the five services (no double counting — rtdb and rtdb-modular are distinct row sets).
  const allServiceRows = ledger.entries.filter((r) => servicesInScope.includes(r.surface));
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
    entryPath: entryPath(),
  };
}

// ── Human table ──────────────────────────────────────────────────────────

/**
 * One-line scope statement per surface. Mirror summaries are derived from the
 * census/dispositions; native and integration boundaries remain authored.
 */
function formatBehaviorRow(
  label: string,
  runtimePublic: string,
  typesPublic: string,
  behavior: BehaviorConformance,
): string {
  const counts = `${behavior.captureProven}/${behavior.selfTested}/${behavior.total.denominator}`;
  return [
    label.padEnd(18),
    runtimePublic.padStart(15),
    typesPublic.padStart(13),
    `${behavior.total.captureProvenPct}%`.padStart(13),
    `${behavior.intended.captureProvenPct}%`.padStart(16),
    `${behavior.total.selfTestedPct}%`.padStart(18),
    `${behavior.intended.selfTestedPct}%`.padStart(21),
    counts.padStart(17),
    String(behavior.divergedDocumented).padStart(9),
    String(behavior.unverified).padStart(10),
  ].join('  ');
}

function formatMirrorRuntimeScope(dispositionedCount: number): string {
  if (dispositionedCount === 0) return 'all public runtime exports are mapped';
  return `${dispositionedCount} absent runtime export(s) have reviewed dispositions`;
}

export function formatCoverageTable(report: CoverageReport, model: ConformanceModel): string {
  const scopeNotes = Object.fromEntries(model.documentation.descriptors.map((descriptor) => {
    if (descriptor.scopeNote) return [descriptor.surface, descriptor.scopeNote];
    if (descriptor.kind !== 'mirror') throw new Error(`Missing scope note for ${descriptor.surface}`);
    const census = model.census.find(({ surface }) => surface === descriptor.censusSurface);
    if (!census) throw new Error(`Missing census for ${descriptor.surface}`);
    const runtime = formatMirrorRuntimeScope(census.runtime.dispositioned.length);
    return [descriptor.surface, `${runtime}; ${census.types.unmapped.length} public type gap(s) remain visible in the denominator.`];
  })) as Record<Surface, string>;

  const lines: string[] = [
    '# Compatibility coverage',
    '',
    'PUBLIC RUNTIME surface counts Firebase exports not exactly reviewed as private in a surface contract. PUBLIC TYPE surface counts non-underscore Firebase exported types.',
    'Deprecated, unsupported, and not-yet-built public APIs stay in their denominator. Pyric-only exports receive no credit.',
    'BEHAVIOR conformance splits conforming rows into two non-overlapping evidence tiers:',
    '  - proven(total / intended): `conforms` rows backed by a real Firebase capture observation.',
    '  - self-tested(total / intended): `conforms` rows backed only by Pyric\'s own tests without a Firebase capture.',
    'Behavior `intended` excludes unsupported rows only; `proven/self/total` gives the exact row counts.',
    '',
  ];
  for (const s of report.services) {
    lines.push(`  ${s.surface}: ${scopeNotes[s.surface]}`);
  }
  lines.push('');

  const header =
    'service             runtime(public)  types(public)  proven(total)  proven(intended)  self-tested(total)  self-tested(intended)  proven/self/total  diverged  unverified';
  lines.push(header);
  lines.push('-'.repeat(header.length));
  for (const s of report.services) {
    const noCensusLabel = s.kind === 'integration' ? 'integration' : 'native';
    const runtimePublic = s.surfaceCoverage ? `${s.surfaceCoverage.runtime.pct}%` : noCensusLabel;
    const typesPublic = s.surfaceCoverage ? `${s.surfaceCoverage.types.pct}%` : noCensusLabel;
    lines.push(formatBehaviorRow(s.surface, runtimePublic, typesPublic, s.behavior));
  }
  lines.push('-'.repeat(header.length));
  lines.push(
    formatBehaviorRow(
      'OVERALL',
      `${report.overall.surfaceCoverage.runtime.pct}%`,
      `${report.overall.surfaceCoverage.types.pct}%`,
      report.overall.behavior,
    ),
  );
  lines.push('');
  lines.push('PUBLIC surface reads `native` for a Pyric-owned API and `integration` for unchanged upstream code run through a Pyric runtime seam; neither has a Firebase denominator. OVERALL public surface sums mirror surfaces only.');
  lines.push('');
  lines.push(`High-risk unverified conforms rows: ${report.highRiskUnverified.length}`);
  lines.push(`Orphan observations: ${report.orphanObservations.length}`);
  lines.push('');
  lines.push('Entry-path (compat:entry-path -- CLIFF, not a ratchet; a green program that regresses is a published FAILURE, never tolerated):');
  for (const p of report.entryPath) {
    lines.push(`  ${p.program.padEnd(12)} ${p.verdict}`);
  }
  return lines.join('\n');
}

function printTable(report: CoverageReport, model: ConformanceModel): void {
  console.log(formatCoverageTable(report, model));
}

// ── main ─────────────────────────────────────────────────────────────────

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function readBaseReport(path: string): CoverageBaseline {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CoverageBaseline;
  } catch (err) {
    throw new Error(`Base coverage report at ${path} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const baseReportPath = flagValue('--base-report');
  const baseCommit = flagValue('--base-commit');
  const reportOut = flagValue('--report-out');
  if (baseReportPath !== undefined && baseCommit === undefined) {
    throw new Error('--base-report needs --base-commit <sha>, the commit the base report describes');
  }

  const model = await deriveConformanceModel();
  const report = buildReport(model);
  if (reportOut !== undefined) writeFileSync(reportOut, JSON.stringify(report) + '\n');

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  printTable(report, model);

  if (baseReportPath === undefined || baseCommit === undefined) {
    console.log('\nNo base report given, so no regression check ran. CI compares this report with the base commit\'s (scripts/ci/conformance-gates.sh); pass --base-report <file> --base-commit <sha> to run it here.');
    process.exit(0);
  }

  const shortBase = baseCommit.slice(0, 9);
  const regressions = findRegressions(readBaseReport(baseReportPath), report, loadAddedAcceptances(baseCommit));

  if (regressions.length > 0) {
    console.log(`\n✗ ${regressions.length} regression(s) vs. the base commit ${shortBase}:`);
    for (const r of regressions) console.log(`  - ${r}`);
    console.log(`\nTo accept a deliberate demotion or removal of a row, add ${ACCEPTANCES_DIR}/<row-id>.md in this change, with the reason and the issue. Other regressions have no acceptance file: fix them.`);
    process.exit(1);
  }

  console.log(`\n✓ No regressions vs. the base commit ${shortBase}.`);
  process.exit(0);
}

if (import.meta.main) await main();
