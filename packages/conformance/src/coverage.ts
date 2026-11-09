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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CensusSurface } from '../surfaces/types.ts';
import { type Surface } from '../registry/index.ts';
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

// ── Regression gate: the head report against the base commit's report ───────

/** Where a change adds `<row-id>.md` to accept that row's demotion or removal. */
export const ACCEPTANCES_DIR = 'packages/conformance/coverage-acceptances';

/**
 * One acceptance file. The change that demotes a `conforms` row, or removes a
 * row, adds `coverage-acceptances/<row-id>.md` with the reason and the issue.
 * A row accepted before gets `<row-id>.<pr-or-issue>.md` instead, since its
 * first file already exists. Files sit directly in the directory, never in a
 * subdirectory.
 * Only files the change adds count (loadAddedAcceptances): a file from an
 * earlier merge stays as a record and can never authorize a later change.
 */
export interface CoverageAcceptance {
  rowId: string;
  /** Repo-relative path, as the change added it. */
  path: string;
  text: string;
}

/** `<row-id>.md`, or `<row-id>.<pr-or-issue>.md`. No row id ends in `.<digits>`, so the suffix is unambiguous. */
const ACCEPTANCE_NAME = /^([A-Za-z0-9._-]+#[A-Za-z0-9._-]+?)(?:\.\d+)?\.md$/;
const ISSUE_REFERENCE = /#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/;

export function parseAcceptance(path: string, text: string): CoverageAcceptance {
  const inSubdirectory = dirname(path) !== ACCEPTANCES_DIR;
  if (inSubdirectory) {
    throw new Error(`${path} is in a subdirectory: put it directly in ${ACCEPTANCES_DIR}/`);
  }
  const name = ACCEPTANCE_NAME.exec(basename(path));
  if (!name) throw new Error(`${path} is not named <row-id>.md or <row-id>.<pr-or-issue>.md`);
  if (text.trim() === '') throw new Error(`${path} is empty: give the reason and the issue`);
  if (!ISSUE_REFERENCE.test(text)) throw new Error(`${path} names no issue: add #<n> or the issue's URL`);
  const reason = text.replace(new RegExp(ISSUE_REFERENCE.source, 'g'), '').replace(/[\s.,;:()-]/g, '');
  if (reason === '') throw new Error(`${path} gives no reason: say why the row may regress`);
  return { rowId: name[1], path, text };
}

/** The acceptance files HEAD adds relative to `baseCommit`. An edit or a rename target that already existed does not count. */
export function loadAddedAcceptances(baseCommit: string, repoRoot: string = REPO_ROOT): CoverageAcceptance[] {
  const added = execFileSync(
    'git',
    ['diff', '-z', '--no-renames', '--diff-filter=A', '--name-only', baseCommit, 'HEAD', '--', ACCEPTANCES_DIR],
    { cwd: repoRoot, encoding: 'utf8' },
  ).split('\0').filter((path) => path !== '');
  return added.map((path) => parseAcceptance(path, readFileSync(join(repoRoot, path), 'utf8')));
}

const CONFORMING_DEMOTION = new Set(['bug', 'diverged-documented', 'unverified', 'unsupported']);

function rowRegressions(base: CoverageReport, head: CoverageReport): Map<string, string> {
  const regressed = new Map<string, string>();
  for (const [id, baseStatus] of Object.entries(base.rowStatuses)) {
    const headStatus = head.rowStatuses[id];
    // A row may change status freely below conforms, but it may never just
    // vanish: deleting a `bug`/`unverified` row shrinks the denominator and
    // lifts the published percentage without fixing anything.
    if (headStatus === undefined) {
      regressed.set(id, `${id}: was '${baseStatus}', row removed from the registry`);
    } else if (baseStatus === 'conforms' && CONFORMING_DEMOTION.has(headStatus)) {
      regressed.set(id, `${id}: was 'conforms', now '${headStatus}'`);
    }
  }
  return regressed;
}

function surfaceRegressions(base: CoverageReport, head: CoverageReport): string[] {
  const problems: string[] = [];
  const dropped = (label: string, from: SurfaceCoverage, to: SurfaceCoverage): void => {
    if (to.runtime.pct < from.runtime.pct) problems.push(`${label}: public runtime surface dropped ${from.runtime.pct}% -> ${to.runtime.pct}%`);
    if (to.types.pct < from.types.pct) problems.push(`${label}: public type surface dropped ${from.types.pct}% -> ${to.types.pct}%`);
  };
  const baseServices = new Map(base.services.map((s) => [s.surface, s]));
  for (const s of head.services) {
    const baseSurface = baseServices.get(s.surface)?.surfaceCoverage;
    // A native or integration surface has no breadth percentage to compare.
    if (baseSurface && s.surfaceCoverage) dropped(s.surface, baseSurface, s.surfaceCoverage);
  }
  dropped('overall', base.overall.surfaceCoverage, head.overall.surfaceCoverage);
  return problems;
}

function entryPathRegressions(base: CoverageReport, head: CoverageReport): string[] {
  // The one cliff in this ratchet (see entry-path-gate.ts's header): a program
  // that was green and is no longer fails, whatever it became.
  const problems: string[] = [];
  const headVerdicts = new Map(head.entryPath.map((p) => [p.program, p.verdict]));
  for (const { program, verdict } of base.entryPath) {
    if (verdict !== 'green') continue;
    const headVerdict = headVerdicts.get(program);
    if (headVerdict === undefined) {
      problems.push(`entry-path '${program}': was green, program removed from the corpus`);
    } else if (headVerdict !== 'green') {
      problems.push(`entry-path '${program}': was green, now '${headVerdict}' (a cliff regression, never tolerated)`);
    }
  }
  return problems;
}

/**
 * Regression-only gate. Deliberately does NOT fail on an absolute percentage
 * — a threshold gate invites relabeling rows `conforms` just to clear the
 * bar, which is the exact dishonesty this ratchet exists to prevent. It only
 * fails when something true of the base commit stops being true of the head:
 *   - a row that was `conforms` is no longer `conforms`,
 *   - a row in the base report is gone from the registry (any status),
 *   - a service's public surface coverage % drops,
 *   - a NEW orphan observation appears,
 *   - the high-risk-unverified count increases,
 *   - an entry-path program that was green is not.
 * The first two are excused only by an acceptance file the change adds, and
 * every such file has to name a row that really regressed.
 */
export function findRegressions(
  base: CoverageReport,
  head: CoverageReport,
  acceptances: readonly CoverageAcceptance[],
): string[] {
  const problems = surfaceRegressions(base, head);

  const regressedRows = rowRegressions(base, head);
  const accepted = new Set(acceptances.map((a) => a.rowId));
  for (const [id, problem] of regressedRows) {
    if (!accepted.has(id)) problems.push(problem);
  }
  for (const acceptance of acceptances) {
    if (!regressedRows.has(acceptance.rowId)) {
      problems.push(`${acceptance.path} names '${acceptance.rowId}', which did not regress against the base report`);
    }
  }

  const baseOrphans = new Set(base.orphanObservations);
  const newOrphans = head.orphanObservations.filter((o) => !baseOrphans.has(o));
  if (newOrphans.length > 0) problems.push(`${newOrphans.length} NEW orphan observation(s): ${newOrphans.join(', ')}`);

  if (head.highRiskUnverified.length > base.highRiskUnverified.length) {
    problems.push(`high-risk unverified rows increased: ${base.highRiskUnverified.length} -> ${head.highRiskUnverified.length}`);
  }

  problems.push(...entryPathRegressions(base, head));
  return problems;
}

// ── main ─────────────────────────────────────────────────────────────────

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function readBaseReport(path: string): CoverageReport {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CoverageReport;
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
