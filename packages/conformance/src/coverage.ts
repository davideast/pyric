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
import type { CensusSurface } from '../surfaces/types.ts';
import { type Surface } from '../registry/index.ts';
import { buildCompatibilityLedger, highRiskUnverifiedRows, type RegistryEntry } from './ledger.ts';
import { deriveConformanceModel, type ConformanceModel } from './conformance-model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const ENTRY_PATH_GATE_SCRIPT = join(HERE, 'entry-path-gate.ts');
const BASELINE_PATH = join(HERE, '..', 'baselines', 'coverage-baseline.json');
const ROW_REMOVAL_ALLOWLIST_PATH = join(HERE, '..', 'row-removal-allowlist.json');

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
interface EntryPathProgramSummary {
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

function buildReport(model: ConformanceModel): CoverageReport {
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

  const entryPath = runEntryPathGate();

  return {
    generatedAt: new Date().toISOString(),
    services,
    overall: { surfaceCoverage: overallSurface, behavior: overallBehavior },
    orphanObservations: ledger.orphanObservations.map((o) => o.name),
    highRiskUnverified: highRisk,
    rowStatuses,
    entryPath,
  };
}

// ── Human table ──────────────────────────────────────────────────────────

/**
 * One-line scope statement per surface. Mirror summaries are derived from the
 * census/dispositions; native and integration boundaries remain authored.
 */
function printTable(report: CoverageReport, model: ConformanceModel): void {
  const scopeNotes = Object.fromEntries(model.documentation.descriptors.map((descriptor) => {
    if (descriptor.scopeNote) return [descriptor.surface, descriptor.scopeNote];
    if (descriptor.kind !== 'mirror') throw new Error(`Missing scope note for ${descriptor.surface}`);
    const census = model.census.find(({ surface }) => surface === descriptor.censusSurface);
    if (!census) throw new Error(`Missing census for ${descriptor.surface}`);
    const runtime = census.runtime.dispositioned.length === 0
      ? 'all public runtime exports are mapped'
      : `${census.runtime.dispositioned.length} absent runtime export(s) have reviewed dispositions`;
    return [descriptor.surface, `${runtime}; ${census.types.unmapped.length} public type gap(s) remain visible in the denominator.`];
  })) as Record<Surface, string>;
  console.log('# Compatibility coverage\n');
  console.log('PUBLIC RUNTIME surface counts Firebase exports not exactly reviewed as private in a surface contract. PUBLIC TYPE surface counts non-underscore Firebase exported types.');
  console.log('Deprecated, unsupported, and not-yet-built public APIs stay in their denominator. Pyric-only exports receive no credit.');
  console.log('BEHAVIOR conformance (`conforms` rows / evaluated rows) is the FIDELITY of the already-implemented slice — "of the calls that exist, do they behave like prod." It is never a standalone completeness grade.');
  console.log('Behavior `intended` excludes unsupported rows only; every five-state count remains available in the registry.\n');
  for (const s of report.services) {
    console.log(`  ${s.surface}: ${scopeNotes[s.surface]}`);
  }
  console.log('');

  const header = 'service         runtime(public)  types(public)  behavior(total)  behavior(intended)  diverged  unverified';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of report.services) {
    // A native surface has no upstream breadth denominator — its SURFACE cells
    // read 'native', never a percentage, so a reader can never confuse "N% of
    // my own exports claimed" with "N% of upstream mirrored".
    const noCensusLabel = s.kind === 'integration' ? 'integration' : 'native';
    const runtimePublic = s.surfaceCoverage ? `${s.surfaceCoverage.runtime.pct}%` : noCensusLabel;
    const typesPublic = s.surfaceCoverage ? `${s.surfaceCoverage.types.pct}%` : noCensusLabel;
    console.log(
      [
        s.surface.padEnd(15),
        runtimePublic.padStart(15),
        typesPublic.padStart(13),
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
      `${report.overall.surfaceCoverage.runtime.pct}%`.padStart(15),
      `${report.overall.surfaceCoverage.types.pct}%`.padStart(13),
      `${report.overall.behavior.total.pct}%`.padStart(16),
      `${report.overall.behavior.intended.pct}%`.padStart(19),
      String(report.overall.behavior.divergedDocumented).padStart(9),
      String(report.overall.behavior.unverified).padStart(11),
    ].join('  '),
  );
  console.log('\nPUBLIC surface reads `native` for a Pyric-owned API and `integration` for unchanged upstream code run through a Pyric runtime seam; neither has a Firebase denominator. OVERALL public surface sums mirror surfaces only.');
  console.log(`\nHigh-risk unverified conforms rows: ${report.highRiskUnverified.length}`);
  console.log(`Orphan observations: ${report.orphanObservations.length}`);

  console.log('\nEntry-path (compat:entry-path — CLIFF, not a ratchet; a green program that regresses is a published FAILURE, never tolerated):');
  for (const p of report.entryPath) {
    console.log(`  ${p.program.padEnd(12)} ${p.verdict}`);
  }
}

// ── Baseline + regression gate ──────────────────────────────────────────────

interface BaselineService {
  /** Absent for a native surface (no upstream breadth to ratchet). */
  publicSurface?: SurfaceCoverage;
  /** Marks a native surface so the regression gate skips its (absent) breadth. */
  native?: boolean;
  /** Marks an unchanged-upstream integration surface with no export census. */
  integration?: boolean;
}

export interface Baseline {
  generatedAt: string;
  services: Record<string, BaselineService>;
  overall: { publicSurface: SurfaceCoverage };
  rowStatuses: Record<string, string>;
  highRiskUnverified: string[];
  orphanObservations: string[];
  /** program -> verdict, at baseline time. See findRegressions()'s entry-path
   *  rule: this is the ONE cliff exception to the ratchet — a program that
   *  was 'green' and is no longer is a FAILURE, full stop, never tolerated. */
  entryPathVerdicts: Record<string, string>;
}

/**
 * The reviewed escape hatch for DELETING a baseline registry row.
 *
 * Without it the ratchet could be cleared by deleting inconvenient rows rather
 * than fixing them — dropping a `bug` row shrinks the denominator and lifts the
 * published percentage, which is the same relabeling dishonesty this file
 * exists to prevent, spelled with a delete key. A row may therefore only leave
 * the registry if its id is listed here with a reason, in the diff, under
 * review. Absent/empty file = no removals permitted.
 */
export interface RowRemoval {
  /** Why this row is allowed to leave the registry (e.g. merged into another row, surface retired). */
  reason: string;
}

export type RowRemovalAllowlist = Record<string, RowRemoval>;

export function loadRowRemovalAllowlist(path: string = ROW_REMOVAL_ALLOWLIST_PATH): RowRemovalAllowlist {
  if (!existsSync(path)) return {};
  let allowlist: RowRemovalAllowlist;
  try {
    allowlist = JSON.parse(readFileSync(path, 'utf8')) as RowRemovalAllowlist;
  } catch (err) {
    // A raw SyntaxError names neither the file nor the gate; this hatch is
    // hand-authored, so the reader needs to be told exactly what to fix.
    throw new Error(`Row-removal allowlist at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const [id, entry] of Object.entries(allowlist)) {
    if (typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`Row-removal allowlist entry '${id}' needs a non-empty reason`);
    }
  }
  return allowlist;
}

function toBaseline(report: CoverageReport): Baseline {
  return {
    generatedAt: report.generatedAt,
    services: Object.fromEntries(
      report.services.map((s): [string, BaselineService] => [
        s.surface,
        s.surfaceCoverage
          ? { publicSurface: s.surfaceCoverage }
          : s.kind === 'integration' ? { integration: true } : { native: true },
      ]),
    ),
    overall: { publicSurface: report.overall.surfaceCoverage },
    rowStatuses: report.rowStatuses,
    highRiskUnverified: report.highRiskUnverified,
    orphanObservations: report.orphanObservations,
    entryPathVerdicts: Object.fromEntries(report.entryPath.map((p) => [p.program, p.verdict])),
  };
}

/**
 * Regression-only gate. Deliberately does NOT fail on an absolute percentage
 * — a threshold gate invites relabeling rows `conforms` just to clear the
 * bar, which is the exact dishonesty this ratchet exists to prevent. It only
 * fails when something that WAS true stops being true:
 *   - a row that was `conforms` is no longer `conforms`,
 *   - a row in the baseline is gone from the registry (any previous status)
 *     without an entry in the row-removal allowlist,
 *   - a service's surface coverage % drops,
 *   - a NEW orphan observation appears,
 *   - the high-risk-unverified count increases.
 */
export function findRegressions(
  baseline: Baseline,
  report: CoverageReport,
  allowedRowRemovals: RowRemovalAllowlist,
): string[] {
  const problems: string[] = [];

  for (const s of report.services) {
    const base = baseline.services[s.surface];
    // A native surface has no breadth percentage to ratchet — skip. (Both the
    // report side and the baseline side are absent for native.)
    if (!base || !base.publicSurface || !s.surfaceCoverage) continue;
    if (s.surfaceCoverage.runtime.pct < base.publicSurface.runtime.pct) {
      problems.push(`${s.surface}: public runtime surface dropped ${base.publicSurface.runtime.pct}% -> ${s.surfaceCoverage.runtime.pct}%`);
    }
    if (s.surfaceCoverage.types.pct < base.publicSurface.types.pct) {
      problems.push(`${s.surface}: public type surface dropped ${base.publicSurface.types.pct}% -> ${s.surfaceCoverage.types.pct}%`);
    }
  }
  if (report.overall.surfaceCoverage.runtime.pct < baseline.overall.publicSurface.runtime.pct) {
    problems.push(`overall: public runtime surface dropped ${baseline.overall.publicSurface.runtime.pct}% -> ${report.overall.surfaceCoverage.runtime.pct}%`);
  }
  if (report.overall.surfaceCoverage.types.pct < baseline.overall.publicSurface.types.pct) {
    problems.push(`overall: public type surface dropped ${baseline.overall.publicSurface.types.pct}% -> ${report.overall.surfaceCoverage.types.pct}%`);
  }

  const CONFORMING_DEMOTION = new Set(['bug', 'diverged-documented', 'unverified', 'unsupported']);
  for (const [id, prevStatus] of Object.entries(baseline.rowStatuses)) {
    const currentStatus = report.rowStatuses[id];
    // A baseline row may change status freely below conforms, but it may never
    // just vanish: deleting a `bug`/`unverified` row shrinks the denominator
    // and lifts the published percentage without fixing anything. Only an
    // allowlist entry — authored, reasoned, and reviewable in the diff —
    // excuses a deletion, whatever the row's previous status.
    if (currentStatus === undefined) {
      if (!allowedRowRemovals[id]) {
        problems.push(`${id}: was '${prevStatus}', row removed from the registry`);
      }
      continue;
    }
    if (prevStatus === 'conforms' && CONFORMING_DEMOTION.has(currentStatus)) {
      problems.push(`${id}: was 'conforms', now '${currentStatus}'`);
    }
  }

  // An allowlist entry is a grant for ONE removal, not a standing permission.
  // Left behind after the removal lands (or the row's later re-addition), it
  // silently pre-authorizes deleting that row again — the reviewer who approved
  // the original reason never saw the second deletion. So every entry must be
  // EXERCISED right now: named in the baseline and gone from the registry.
  // Anything else is dead configuration and has to be deleted from the file.
  for (const id of Object.keys(allowedRowRemovals)) {
    if (report.rowStatuses[id] !== undefined) {
      problems.push(`allowlist entry '${id}' is stale: row present in registry`);
    }
    if (baseline.rowStatuses[id] === undefined) {
      problems.push(`allowlist entry '${id}' is stale: id not in baseline`);
    }
  }

  const baselineOrphans = new Set(baseline.orphanObservations);
  const newOrphans = report.orphanObservations.filter((o) => !baselineOrphans.has(o));
  if (newOrphans.length > 0) problems.push(`${newOrphans.length} NEW orphan observation(s): ${newOrphans.join(', ')}`);

  if (report.highRiskUnverified.length > baseline.highRiskUnverified.length) {
    problems.push(`high-risk unverified rows increased: ${baseline.highRiskUnverified.length} -> ${report.highRiskUnverified.length}`);
  }

  // Entry-path: the one CLIFF exception to this whole function's ratchet
  // framing (see entry-path-gate.ts's header). A program that was GREEN and
  // is no longer is a FAILURE here regardless of WHY (red, red-known, or a
  // now-stale expected-failure) — there is no tolerance, unlike every other
  // check in this function, which only flags a regression once it crosses a
  // baseline it previously cleared.
  for (const [program, prevVerdict] of Object.entries(baseline.entryPathVerdicts)) {
    if (prevVerdict !== 'green') continue;
    const currentVerdict = report.entryPath.find((p) => p.program === program)?.verdict;
    if (currentVerdict === undefined) {
      problems.push(`entry-path '${program}': was green, program removed from the corpus`);
    } else if (currentVerdict !== 'green') {
      problems.push(`entry-path '${program}': was green, now '${currentVerdict}' — CLIFF regression, never tolerated`);
    }
  }

  return problems;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const updateBaseline = process.argv.includes('--update-baseline');

  const model = await deriveConformanceModel();
  const report = buildReport(model);

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(toBaseline(report), null, 2) + '\n');
    console.log(`Baseline updated: ${BASELINE_PATH.replace(REPO_ROOT + '/', '')}`);
    console.log(`  overall public surface: runtime ${report.overall.surfaceCoverage.runtime.pct}%, types ${report.overall.surfaceCoverage.types.pct}%`);
    console.log(`  overall behavior conformance: total ${report.overall.behavior.total.pct}%, intended ${report.overall.behavior.intended.pct}%`);
    process.exit(0);
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  printTable(report, model);

  if (!existsSync(BASELINE_PATH)) {
    console.log('\n! No coverage-baseline.json found — run `bun run compat:coverage --update-baseline` to create one.');
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  const regressions = findRegressions(baseline, report, loadRowRemovalAllowlist());

  if (regressions.length > 0) {
    console.log(`\n✗ ${regressions.length} regression(s) vs. coverage-baseline.json:`);
    for (const r of regressions) console.log(`  - ${r}`);
    console.log('\nIf this is an intentional change (a legit new diverged/unsupported row, a scoped-down surface), run `bun run compat:coverage --update-baseline` in this PR to accept the new baseline.');
    process.exit(1);
  }

  console.log('\n✓ No regressions vs. coverage-baseline.json.');
  process.exit(0);
}

if (import.meta.main) await main();
