#!/usr/bin/env bun
/**
 * Compatibility coverage — the published, tracked, regression-guarded number.
 *
 * Combines two axes that packages/conformance/src/surface-census.ts and
 * packages/conformance/src/ledger.ts already compute, per COMPAT service:
 *
 *   SURFACE coverage   = mirrored SDK exports / SDK exports (surface-census).
 *   BEHAVIOR conformance = `conforms` registry rows / evaluated rows (ledger).
 *
 * Each axis is reported on two scopes:
 *   total    — over every export / row, no exclusions.
 *   intended — total minus what is GENUINELY OUT OF SCOPE (surface
 *              deny-list entries tagged `out-of-scope` — the sandbox truly
 *              cannot model them — for surface coverage; `status:
 *              'unsupported'` rows for behavior conformance). Deny-list
 *              entries tagged `deferred` (intended, not yet built) are NOT
 *              subtracted — they stay in `intended` as coverage debt. See
 *              surface-denylist.ts for the two-tier policy this encodes; the
 *              previous version of this script subtracted both tiers, which
 *              inflated the published number by counting planned work as if
 *              it had been scoped out.
 *
 * The HEADLINE metric is total-INTENDED SURFACE coverage per service — "will
 * my app's calls exist against the mirror" (breadth). Behavior conformance is
 * the FIDELITY of the already-implemented slice — "of the calls that exist,
 * do they behave like prod" — and is never a standalone completeness grade;
 * it says nothing about the calls that don't exist yet.
 *
 * `diverged-documented` and `unverified` rows are broken out separately and
 * are NEVER folded into `conforms` — doing so would be exactly the kind of
 * relabeling-to-game-the-number this script exists to prevent.
 *
 * A third axis is published alongside them:
 *
 *   RULES-LANGUAGE verified coverage = production-verified constructs /
 *              counted constructs, per engine. A construct is production-verified
 *              only when positive evidence backs it AND no `diverged-documented`/
 *              `bug` rules-engine row scopes it (src/production-verification.ts, the one
 *              predicate the assurance generator shares). It is recomputed here
 *              rather than read from the committed report, so the gate ratchets
 *              what today's evidence says.
 *
 * NUMBER-MOVEMENT ACCOUNTING
 *
 * Every ratio above is tracked as a NUMERATOR and a DENOMINATOR, not as a
 * percentage, and the gate reasons about which half moved. A number that rose
 * because a scenario was captured or an export was mirrored is work. A number
 * that rose because its denominator shrank — a symbol deny-listed, a construct
 * excluded, a row reclassified out of the evaluated set — is not, and once the
 * two are divided into a percentage they are indistinguishable. See
 * classifyMovements(): a ratio that improved on a shrinking denominator, or a
 * numerator that rose while the EVIDENCE census stood still, FAILS this gate. The
 * accept mechanism is `--update-baseline`, committed in the PR, which prints
 * exactly what it is accepting before it writes.
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
import { denyTierFor, type CensusSurface } from './surface-denylist.ts';
import { type Surface } from '../registry/index.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';
import { buildCompatibilityLedger, highRiskUnverifiedRows, type RegistryEntry } from './ledger.ts';
import { computeCoverageReport as computeRulesLanguageCoverage } from './rules-language-analyzer.ts';
import { behaviorHash } from './observation-hash.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CENSUS_SCRIPT = join(HERE, 'surface-census.ts');
const ENTRY_PATH_GATE_SCRIPT = join(HERE, 'entry-path-gate.ts');
const BASELINE_PATH = join(HERE, '..', 'baselines', 'coverage-baseline.json');

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

// ── Entry-path (surface-census.ts's sibling CLIFF gate — reused, not
// reimplemented) ────────────────────────────────────────────────────────────

/** One program's result, as entry-path-gate.ts --json reports it (subset). */
interface EntryPathProgramSummary {
  program: string;
  verdict: 'green' | 'red-known' | 'red' | 'stale-expected-failure';
}

function runEntryPathGate(): EntryPathProgramSummary[] {
  // Same subprocess-reuse pattern as runCensus() just above: entry-path-
  // gate.ts exits 1 whenever a program is genuinely RED (or an
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
const SERVICES: Surface[] = surfaceDescriptors.filter((d) => d.coverage).map((d) => d.surface);

/** Surface -> its descriptor, so the coverage math can branch on `kind`. */
const DESCRIPTOR_FOR = new Map(surfaceDescriptors.map((d) => [d.surface, d]));

/**
 * A MIRROR surface's underlying surface-census surface. Native surfaces have no
 * upstream to census and are absent from this map — the SURFACE (breadth) axis
 * does not apply to them; their completeness is the CLAIMED-API axis instead
 * (published as `native` in the table until the Phase 3 symbol-claims gate
 * lands). `rtdb-modular` is the sole owner of the `database` census now that
 * classic `rtdb` is native.
 */
const CENSUS_SURFACE_FOR: Map<Surface, CensusSurface> = new Map(
  surfaceDescriptors.flatMap((d) => (d.kind === 'mirror' ? [[d.surface, d.censusSurface] as const] : [])),
);

interface SurfaceCoverage {
  mapped: number;
  total: { denominator: number; pct: number };
  intended: { denominator: number; pct: number };
}

function surfaceCoverageFor(census: CensusRow): SurfaceCoverage {
  const mapped = census.mapped.length;
  const totalDenominator = census.upstreamCount;
  // `intended` subtracts ONLY genuinely out-of-scope symbols — deferred
  // (intended-but-unbuilt) symbols stay in the denominator as coverage debt.
  // See surface-denylist.ts's header for the policy this encodes.
  const tiers = denyTierFor(census.surface);
  const outOfScopeCount = census.denied.filter((d) => tiers.get(d.symbol) === 'out-of-scope').length;
  const intendedDenominator = census.upstreamCount - outOfScopeCount;
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
  /** 'mirror' surfaces have an upstream census; 'native' surfaces do not. */
  kind: 'mirror' | 'native';
  /** The census surface for a mirror service; null for a native one. */
  censusSurface: CensusSurface | null;
  /** SURFACE (breadth) coverage — null for a native surface (no upstream denominator). */
  surfaceCoverage: SurfaceCoverage | null;
  behavior: BehaviorConformance;
}

/** One rules engine's language coverage, from the rules-language analyzer. */
interface RulesLanguageCoverage {
  engine: string;
  /** Production-verified constructs (positive evidence, no divergence covering
   *  them — src/production-verification.ts). */
  verified: number;
  /** Constructs some corpus scenario's AST contains. */
  exercised: number;
  /** The denominator: snapshot constructs minus the excluded ones. */
  total: number;
  /** Counted constructs a `diverged-documented`/`bug` rules-engine row scopes.
   *  These can never be verified: the gap between exercised and verified is
   *  attributable to a named row, not to missing capture. */
  contaminated: number;
  pct: number;
  /** The construct ids taken OUT of the denominator, so the gate can see an
   *  exclusion appear (a denominator shrink is a reclassification, not work). */
  excluded: string[];
  /** Corpus scenarios with an observation twin — the evidence behind `verified`. */
  scenariosWithTwins: number;
}

/**
 * One tracked ratio, as a FRACTION rather than a percentage. The gate reasons
 * about a number's movement by reasoning about its parts: a percentage that rose
 * says nothing about why, and "why" is the whole question — a numerator that rose
 * on new evidence and a denominator that shrank on a reclassification look
 * identical once they are divided.
 */
export interface Metric {
  numerator: number;
  denominator: number;
}

/**
 * The EVIDENCE census: the quantities that can only grow by doing real work —
 * capturing production, writing a probe, mirroring an export. A coverage
 * improvement has to be explainable by one of these having moved. Nothing here
 * can be raised by editing a label.
 */
export interface EvidenceCensus {
  /** Committed observation files: production captured. */
  observations: number;
  /** A digest over every observation's name and behaviorHash. Changes when a
   *  capture is added, removed, or RE-captured (its recorded verdicts changed).
   *  The behavior hashes are validated content hashes (src/observation-hash.ts),
   *  so this tracks the evidence itself, not a claim about it. */
  observationDigest: string;
  /** Corpus scenarios that have an observation twin, summed over the engines. */
  verifiedScenarios: number;
  /** Structured row->observation checks: replayed findings. */
  conformanceChecks: number;
  /** Conformance test files cited by rows. */
  conformanceTests: number;
  /** Upstream SDK exports the mirror actually maps: implementation. */
  mappedExports: number;
}

export interface CoverageReport {
  generatedAt: string;
  services: ServiceCoverage[];
  overall: {
    surfaceCoverage: SurfaceCoverage;
    behavior: BehaviorConformance;
  };
  /** The third published axis: rules-language verified coverage per engine. */
  rulesLanguage: RulesLanguageCoverage[];
  /** Every published ratio, as numerator/denominator, keyed by a stable id. The
   *  number-movement gate reads these; the percentages above are for humans. */
  metrics: Record<string, Metric>;
  /** What real work exists behind the numbers (see EvidenceCensus). */
  evidence: EvidenceCensus;
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

async function buildReport(): Promise<CoverageReport> {
  const censuses = runCensus();
  const censusBySurface = new Map(censuses.map((c) => [c.surface, c]));
  const ledger = buildCompatibilityLedger();

  const services: ServiceCoverage[] = SERVICES.map((surface) => {
    const rows = ledger.entries.filter((r) => r.surface === surface);
    const behavior = behaviorConformanceFor(rows);
    const censusSurface = CENSUS_SURFACE_FOR.get(surface);
    // Native surface: no upstream census. Report behavior only; the SURFACE
    // (breadth) column is 'native', not a percentage against a denominator
    // that does not exist.
    if (censusSurface === undefined) {
      return { surface, kind: 'native', censusSurface: null, surfaceCoverage: null, behavior };
    }
    const census = censusBySurface.get(censusSurface);
    if (!census) throw new Error(`No surface census entry for '${censusSurface}' (service '${surface}')`);
    return { surface, kind: 'mirror', censusSurface, surfaceCoverage: surfaceCoverageFor(census), behavior };
  });

  // Overall surface coverage: sum each UNIQUE census surface once, over MIRROR
  // services only (native surfaces have no upstream breadth to fold in).
  const uniqueCensusSurfaces = new Set(
    SERVICES.map((s) => CENSUS_SURFACE_FOR.get(s)).filter((cs): cs is CensusSurface => cs !== undefined),
  );
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

  const entryPath = runEntryPathGate();

  // The rules-language axis: verified constructs / counted constructs, per
  // engine. Recomputed here from the analyzer (not read from the committed
  // report) so the gate ratchets what the evidence says today.
  const languageReport = await computeRulesLanguageCoverage();
  const rulesLanguage: RulesLanguageCoverage[] = languageReport.engines.map((e) => ({
    engine: e.engine,
    verified: e.verifiedConstructs,
    exercised: e.exercisedConstructs,
    total: e.totalConstructs,
    contaminated: e.contaminatedConstructs,
    pct: pct(e.verifiedConstructs, e.totalConstructs),
    excluded: e.constructs.filter((c) => c.excluded).map((c) => c.id).sort(),
    scenariosWithTwins: e.verifiedScenarioCount,
  }));

  // Every published ratio as numerator/denominator, so the movement gate can ask
  // WHICH half moved.
  const metrics: Record<string, Metric> = {};
  for (const s of services) {
    if (s.surfaceCoverage) {
      metrics[`surface:${s.surface}:total`] = { numerator: s.surfaceCoverage.mapped, denominator: s.surfaceCoverage.total.denominator };
      metrics[`surface:${s.surface}:intended`] = { numerator: s.surfaceCoverage.mapped, denominator: s.surfaceCoverage.intended.denominator };
    }
    metrics[`behavior:${s.surface}:total`] = { numerator: s.behavior.conforms, denominator: s.behavior.total.denominator };
    metrics[`behavior:${s.surface}:intended`] = { numerator: s.behavior.conforms, denominator: s.behavior.intended.denominator };
  }
  metrics['surface:overall:total'] = { numerator: overallSurface.mapped, denominator: overallSurface.total.denominator };
  metrics['surface:overall:intended'] = { numerator: overallSurface.mapped, denominator: overallSurface.intended.denominator };
  metrics['behavior:overall:total'] = { numerator: overallBehavior.conforms, denominator: overallBehavior.total.denominator };
  metrics['behavior:overall:intended'] = { numerator: overallBehavior.conforms, denominator: overallBehavior.intended.denominator };
  for (const e of rulesLanguage) {
    metrics[`rules-language:${e.engine}:verified`] = { numerator: e.verified, denominator: e.total };
  }

  const observationSeals = Object.fromEntries(
    [...ledger.observations].sort((a, b) => a.name.localeCompare(b.name)).map((o) => [o.name, o.behaviorHash ?? '']),
  );
  const evidence: EvidenceCensus = {
    observations: ledger.observations.length,
    observationDigest: behaviorHash(observationSeals),
    verifiedScenarios: rulesLanguage.reduce((sum, e) => sum + e.scenariosWithTwins, 0),
    conformanceChecks: ledger.entries.reduce((sum, r) => sum + (r.conformanceChecks?.length ?? 0), 0),
    conformanceTests: ledger.entries.reduce((sum, r) => sum + r.conformanceTests.length, 0),
    mappedExports: overallSurface.mapped,
  };

  return {
    generatedAt: new Date().toISOString(),
    services,
    overall: { surfaceCoverage: overallSurface, behavior: overallBehavior },
    rulesLanguage,
    metrics,
    evidence,
    orphanObservations: ledger.orphanObservations.map((o) => o.name),
    highRiskUnverified: highRisk,
    rowStatuses,
    entryPath,
  };
}

// ── Human table ──────────────────────────────────────────────────────────

/**
 * One-line scope statement per surface — what's genuinely out of scope (the
 * sandbox cannot model it) vs. deferred (intended, not yet built, counted as a
 * gap against `intended`). Authored per-surface as each descriptor's
 * `scopeNote`; see surface-denylist.ts for the full reasoning behind each entry.
 */
const SCOPE_NOTES: Record<Surface, string> = Object.fromEntries(
  surfaceDescriptors.map((d) => [d.surface, d.scopeNote]),
) as Record<Surface, string>;

function printTable(report: CoverageReport): void {
  console.log('# Compatibility coverage\n');
  console.log('SURFACE coverage (mirrored SDK exports / SDK exports) is the headline TRUST number — breadth: "will my call exist against the mirror."');
  console.log('BEHAVIOR conformance (`conforms` rows / evaluated rows) is the FIDELITY of the already-implemented slice — "of the calls that exist, do they behave like prod." It is never a standalone completeness grade.');
  console.log('`intended` excludes ONLY what is genuinely out of scope (the sandbox cannot model it). Deferred (intended, not yet built) stays IN `intended` as a gap.\n');
  for (const s of report.services) {
    console.log(`  ${s.surface}: ${SCOPE_NOTES[s.surface]}`);
  }
  console.log('');

  const header = 'service         surface(total)  surface(intended)  behavior(total)  behavior(intended)  diverged  unverified';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of report.services) {
    // A native surface has no upstream breadth denominator — its SURFACE cells
    // read 'native', never a percentage, so a reader can never confuse "N% of
    // my own exports claimed" with "N% of upstream mirrored".
    const surfaceTotal = s.surfaceCoverage ? `${s.surfaceCoverage.total.pct}%` : 'native';
    const surfaceIntended = s.surfaceCoverage ? `${s.surfaceCoverage.intended.pct}%` : 'native';
    console.log(
      [
        s.surface.padEnd(15),
        surfaceTotal.padStart(14),
        surfaceIntended.padStart(18),
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
  console.log('\nSURFACE reads `native` for a surface with no upstream module (its completeness is measured against its own public API, not against Firebase); OVERALL surface coverage sums the mirror surfaces only.');

  console.log('\nRULES-LANGUAGE verified coverage (production-verified constructs / counted constructs, per engine).');
  console.log('A construct is production-verified when positive evidence backs it AND no `diverged-documented`/`bug` rules-engine row scopes it: an engine KNOWN WRONG about a construct never counts it verified, however many scenarios exercise it (src/production-verification.ts).');
  console.log('engine       verified   exercised  contaminated  excluded  scenarios(twins)');
  console.log('-'.repeat(72));
  for (const e of report.rulesLanguage) {
    console.log(
      [
        e.engine.padEnd(12),
        `${e.verified}/${e.total} (${e.pct}%)`.padEnd(18),
        String(e.exercised).padStart(4),
        String(e.contaminated).padStart(13),
        String(e.excluded.length).padStart(10),
        String(e.scenariosWithTwins).padStart(12),
      ].join('  '),
    );
  }
  console.log('`contaminated` constructs are the ones a named rules-engine divergence covers: the distance between exercised and verified is a documented divergence, not missing capture.');

  console.log('\nEVIDENCE behind the numbers (the quantities no relabel can raise):');
  console.log(`  observations ${report.evidence.observations}, captured scenario twins ${report.evidence.verifiedScenarios}, conformance checks ${report.evidence.conformanceChecks}, conformance tests ${report.evidence.conformanceTests}, mirrored exports ${report.evidence.mappedExports}`);

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
  surfaceCoveragePct?: { total: number; intended: number };
  /** Marks a native surface so the regression gate skips its (absent) breadth. */
  native?: boolean;
}

export interface Baseline {
  generatedAt: string;
  services: Record<string, BaselineService>;
  overall: { surfaceCoveragePct: { total: number; intended: number } };
  rowStatuses: Record<string, string>;
  highRiskUnverified: string[];
  orphanObservations: string[];
  /** program -> verdict, at baseline time. See findRegressions()'s entry-path
   *  rule: this is the ONE cliff exception to the ratchet — a program that
   *  was 'green' and is no longer is a FAILURE, full stop, never tolerated. */
  entryPathVerdicts: Record<string, string>;
  /** Every published ratio as numerator/denominator (see Metric), so the
   *  number-movement gate can attribute a change to the half that moved. */
  metrics: Record<string, Metric>;
  /** The evidence behind the numbers at baseline time (see EvidenceCensus). */
  evidence: EvidenceCensus;
  /** Construct ids taken out of a rules-language denominator, per engine. A new
   *  entry here is a denominator shrink: a reclassification, not work. */
  rulesLanguageExclusions: Record<string, string[]>;
}

function toBaseline(report: CoverageReport): Baseline {
  return {
    generatedAt: report.generatedAt,
    services: Object.fromEntries(
      report.services.map((s): [string, BaselineService] => [
        s.surface,
        s.surfaceCoverage
          ? { surfaceCoveragePct: { total: s.surfaceCoverage.total.pct, intended: s.surfaceCoverage.intended.pct } }
          : { native: true },
      ]),
    ),
    overall: { surfaceCoveragePct: { total: report.overall.surfaceCoverage.total.pct, intended: report.overall.surfaceCoverage.intended.pct } },
    rowStatuses: report.rowStatuses,
    highRiskUnverified: report.highRiskUnverified,
    orphanObservations: report.orphanObservations,
    entryPathVerdicts: Object.fromEntries(report.entryPath.map((p) => [p.program, p.verdict])),
    metrics: report.metrics,
    evidence: report.evidence,
    rulesLanguageExclusions: Object.fromEntries(report.rulesLanguage.map((e) => [e.engine, e.excluded])),
  };
}

// ── Number-movement accounting ──────────────────────────────────────────────

/**
 * WHY A NUMBER MOVED, and whether that movement is allowed to stand.
 *
 * A published ratio can rise two ways, and they are not the same thing:
 *
 *   the NUMERATOR rose — something got better. An export got mirrored, a
 *   scenario got captured, a construct's evidence landed. Real work; the number
 *   should rise, and the ratchet should hold it there.
 *
 *   the DENOMINATOR shrank — nothing got better. A symbol was declared out of
 *   scope, a construct was excluded, a row was reclassified out of the evaluated
 *   set. The number rises because the question got easier.
 *
 * Divided into a percentage, those two are indistinguishable. That is the fake
 * this accounting exists to prevent: a coverage number that goes up on a PR that
 * captured nothing, mirrored nothing, and fixed nothing.
 *
 * The rules the gate enforces:
 *
 *   1. A ratio that IMPROVED while its denominator SHRANK is reclassification-
 *      driven. It fails, unless the PR deliberately accepts a new baseline.
 *   2. A ratio whose NUMERATOR ROSE while the EVIDENCE CENSUS did not move at
 *      all is a relabel — a row flipped to `conforms`, a construct credited —
 *      with nothing behind it. It fails on the same terms.
 *
 * The accept mechanism is `--update-baseline`, committed in the PR. It does not
 * suppress the accounting; it records the new numbers, and the diff shows what
 * was accepted. Defense #1's contamination rule, which lowers a published number
 * with no new evidence, is accepted exactly this way — deliberately, in a commit,
 * not silently.
 */
export interface Movement {
  metric: string;
  before: Metric;
  after: Metric;
  beforePct: number;
  afterPct: number;
  /** Why it moved. `reclassification` and `unbacked-credit` are the failures. */
  attribution: 'unchanged' | 'new-evidence' | 'regression' | 'reclassification' | 'unbacked-credit' | 'new-metric';
  detail: string;
}

/** What in the evidence census grew. Empty means: this PR added no new evidence. */
function evidenceGrowth(before: EvidenceCensus, after: EvidenceCensus): string[] {
  const grown: string[] = [];
  if (after.observations > before.observations) grown.push(`+${after.observations - before.observations} observation(s)`);
  if (after.verifiedScenarios > before.verifiedScenarios) grown.push(`+${after.verifiedScenarios - before.verifiedScenarios} captured scenario twin(s)`);
  if (after.conformanceChecks > before.conformanceChecks) grown.push(`+${after.conformanceChecks - before.conformanceChecks} conformance check(s)`);
  if (after.conformanceTests > before.conformanceTests) grown.push(`+${after.conformanceTests - before.conformanceTests} conformance test(s)`);
  if (after.mappedExports > before.mappedExports) grown.push(`+${after.mappedExports - before.mappedExports} mirrored export(s)`);
  // Same observation count, different seals: an observation was RE-captured (its
  // recorded production verdicts changed). That is new evidence about production,
  // and — because the seals are content hashes the validator enforces — a change
  // here is a visible change to a capture, never an invisible one.
  if (after.observations === before.observations && after.observationDigest !== before.observationDigest) {
    grown.push('re-captured observation(s) (behavior seals changed)');
  }
  return grown;
}

/** Attribute every metric's movement between the baseline and this run. */
export function classifyMovements(baseline: Baseline, report: CoverageReport): Movement[] {
  const growth = evidenceGrowth(baseline.evidence, report.evidence);
  const movements: Movement[] = [];

  for (const [metric, after] of Object.entries(report.metrics)) {
    const before = baseline.metrics[metric];
    if (!before) {
      movements.push({
        metric, before: { numerator: 0, denominator: 0 }, after,
        beforePct: 0, afterPct: pct(after.numerator, after.denominator),
        attribution: 'new-metric',
        detail: 'not tracked at baseline — nothing to compare against',
      });
      continue;
    }
    const beforePct = pct(before.numerator, before.denominator);
    const afterPct = pct(after.numerator, after.denominator);
    const numeratorDelta = after.numerator - before.numerator;
    const denominatorDelta = after.denominator - before.denominator;

    if (afterPct < beforePct) {
      movements.push({
        metric, before, after, beforePct, afterPct,
        attribution: 'regression',
        detail: `numerator ${numeratorDelta >= 0 ? '+' : ''}${numeratorDelta}, denominator ${denominatorDelta >= 0 ? '+' : ''}${denominatorDelta}`,
      });
      continue;
    }
    if (afterPct === beforePct && numeratorDelta === 0 && denominatorDelta === 0) {
      movements.push({ metric, before, after, beforePct, afterPct, attribution: 'unchanged', detail: '' });
      continue;
    }

    // The ratio IMPROVED (or held while its parts moved). Attribute it.
    if (denominatorDelta < 0 && afterPct > beforePct) {
      movements.push({
        metric, before, after, beforePct, afterPct,
        attribution: 'reclassification',
        detail: `denominator SHRANK by ${-denominatorDelta} (${before.denominator} -> ${after.denominator}) — the number rose because the question got smaller, not because anything got better`,
      });
      continue;
    }
    if (numeratorDelta > 0 && growth.length === 0) {
      movements.push({
        metric, before, after, beforePct, afterPct,
        attribution: 'unbacked-credit',
        detail: `numerator ROSE by ${numeratorDelta} while the evidence census did not move: no new observation, no new captured scenario, no new conformance check or test, no newly mirrored export. Credit with nothing behind it`,
      });
      continue;
    }
    movements.push({
      metric, before, after, beforePct, afterPct,
      attribution: numeratorDelta > 0 ? 'new-evidence' : 'unchanged',
      detail: numeratorDelta > 0 ? `numerator +${numeratorDelta}, backed by: ${growth.join(', ')}` : '',
    });
  }

  return movements;
}

/** The movements the gate refuses to let stand without a deliberate baseline. */
export function movementProblems(movements: Movement[]): string[] {
  return movements
    .filter((m) => m.attribution === 'reclassification' || m.attribution === 'unbacked-credit')
    .map((m) => `${m.metric}: ${m.beforePct}% -> ${m.afterPct}% [${m.attribution}] ${m.detail}`);
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
    // A native surface has no breadth percentage to ratchet — skip. (Both the
    // report side and the baseline side are absent for native.)
    if (!base || !base.surfaceCoveragePct || !s.surfaceCoverage) continue;
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

  // Rules-language verified coverage: a construct that WAS production-verified
  // and no longer is (a divergence found and scoped to it, a capture removed) is
  // a regression on the same terms as a `conforms` row flipping off.
  for (const engine of report.rulesLanguage) {
    const base = baseline.metrics?.[`rules-language:${engine.engine}:verified`];
    if (!base) continue;
    if (engine.verified < base.numerator) {
      problems.push(
        `rules-language ${engine.engine}: production-verified constructs dropped ${base.numerator} -> ${engine.verified} (of ${engine.total})`,
      );
    }
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

/** Print WHY every number that moved, moved. */
function printMovements(movements: Movement[]): void {
  const moved = movements.filter((m) => m.attribution !== 'unchanged');
  console.log('\nNUMBER MOVEMENT vs. coverage-baseline.json — a percentage that rose says nothing about why it rose:');
  if (moved.length === 0) {
    console.log('  (no tracked ratio moved)');
    return;
  }
  for (const m of moved) {
    console.log(
      `  ${m.metric}: ${m.before.numerator}/${m.before.denominator} (${m.beforePct}%) -> ${m.after.numerator}/${m.after.denominator} (${m.afterPct}%) [${m.attribution}]`,
    );
    if (m.detail) console.log(`      ${m.detail}`);
  }
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const updateBaseline = process.argv.includes('--update-baseline');

  const report = await buildReport();

  if (updateBaseline) {
    // The accept mechanism. It prints the accounting BEFORE overwriting, so a
    // baseline is never accepted without the reason for every movement being
    // stated — including a movement the gate would otherwise have refused.
    if (existsSync(BASELINE_PATH)) {
      const previous = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
      if (previous.metrics) {
        const movements = classifyMovements(previous, report);
        printMovements(movements);
        const refused = movementProblems(movements);
        if (refused.length > 0) {
          console.log('\nACCEPTING the following movements, which the gate would otherwise REFUSE:');
          for (const r of refused) console.log(`  - ${r}`);
        }
      }
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(toBaseline(report), null, 2) + '\n');
    console.log(`\nBaseline updated: ${BASELINE_PATH.replace(REPO_ROOT + '/', '')}`);
    console.log(`  overall surface coverage: total ${report.overall.surfaceCoverage.total.pct}%, intended ${report.overall.surfaceCoverage.intended.pct}%`);
    console.log(`  overall behavior conformance: total ${report.overall.behavior.total.pct}%, intended ${report.overall.behavior.intended.pct}%`);
    for (const e of report.rulesLanguage) {
      console.log(`  rules-language ${e.engine}: verified ${e.verified}/${e.total} (${e.pct}%)`);
    }
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

  // A baseline written before the accounting existed carries no `metrics`; it
  // cannot be reasoned about, and pretending otherwise would silently pass every
  // reclassification. Fail loudly and cheaply: regenerate it.
  if (!baseline.metrics || !baseline.evidence) {
    console.log('\n✗ coverage-baseline.json predates number-movement accounting (no `metrics`/`evidence`).');
    console.log('  Run `bun run compat:coverage --update-baseline` to record the current numbers AND the evidence behind them.');
    process.exit(1);
  }

  const movements = classifyMovements(baseline, report);
  printMovements(movements);
  const unearned = movementProblems(movements);

  const problems = [...regressions, ...unearned.map((u) => `UNEARNED MOVEMENT — ${u}`)];
  if (problems.length > 0) {
    console.log(`\n✗ ${problems.length} problem(s) vs. coverage-baseline.json:`);
    for (const p of problems) console.log(`  - ${p}`);
    if (unearned.length > 0) {
      console.log('\nA number rose with nothing behind it: either its denominator shrank (something was excluded, deny-listed, or reclassified out of the evaluated set), or its numerator rose while the evidence census did not move at all. Neither is an improvement.');
      console.log('Fix it by producing the evidence — capture the scenario, mirror the export, fix the engine. If the reclassification is genuinely correct, run `bun run compat:coverage --update-baseline` in this PR: that records the new numbers deliberately, in a diff a reviewer sees.');
    }
    if (regressions.length > 0) {
      console.log('\nIf a regression is an intentional change (a legit new diverged/unsupported row, a scoped-down surface, a divergence newly scoped to a construct), run `bun run compat:coverage --update-baseline` in this PR to accept the new baseline.');
    }
    process.exit(1);
  }

  console.log('\n✓ No regressions and no unearned movement vs. coverage-baseline.json.');
  process.exit(0);
}

// Guarded: the gate's classifier is imported by its test suite, and an
// unguarded main() would run the whole census on import.
if (import.meta.main) await main();
