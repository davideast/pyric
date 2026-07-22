/**
 * Rules-language analyzer (issue #185, step 2).
 *
 * Given ruleset source (Firestore / Storage) or a rules JSON string (RTDB),
 * returns the set of language-construct ids the ruleset EXERCISES, by walking
 * the ASTs the existing parsers already produce — no new parsing. The
 * construct ids are exactly those enumerated in the per-engine language
 * snapshots (rules-language/<engine>.json).
 *
 * This is the numerator producer for the "verified coverage" axis: run the
 * analyzer over every production-captured corpus scenario, and a construct is
 * verified iff some scenario that has an observation twin exercises it.
 *
 * Attribution is deliberately CONSERVATIVE. Method calls whose receiver type
 * cannot be determined from the AST (e.g. a bare `size()` on a value of
 * unknown type, ambiguous across string/list/map/set/bytes) are NOT credited
 * to any construct — they are surfaced as `unresolved` diagnostics instead.
 * Under-counting is honest; over-counting would inflate the trust number the
 * issue is built to protect. The same bar applies to `duration.seconds`/
 * `duration.nanos` vs `timestamp.seconds`/`timestamp.nanos` (same method
 * names, disambiguated only by proving the receiver's type — a namespace
 * constructor, a `request.time`-rooted access, or sound Timestamp/Duration
 * arithmetic — never by guessing) and to the `&&`/`||` error-absorption
 * semantics (credited only from a genuine AST signature: a risky operand
 * FIRST, paired with the absorbing boolean literal SECOND — see `fsIsRisky`).
 *
 * Some snapshot constructs are not merely hard to attribute today but
 * PERMANENTLY unattributable by this method: a pure meta-semantic with no
 * expression-level AST representation (e.g. `storage.semantic.deny-by-default`,
 * `rtdb.semantic.deny-by-default` — ambient engine behavior, not something a
 * ruleset's source text contains). Those constructs carry `unattributable` in
 * their snapshot entry and are excluded from the coverage denominator rather
 * than left looking like an ordinary, someday-closeable gap.
 *
 * SOURCE IS NOT THE ONLY EVIDENCE. Everything above is the SYNTACTIC path: find
 * the construct's node in a captured scenario's ruleset. A construct that IS a
 * behavior of the engine rather than a token of the language (the RTDB cascade
 * semantics: a truthy ancestor `.read`/`.write` grants below it; `.validate`
 * does not cascade) has no node to find and would read 0% verified forever,
 * even though production's captured VERDICTS prove it. Such a construct is
 * credited BEHAVIORALLY, from a `conforms` + `oracle-backed` rules-engine
 * registry row whose `constructs` scope lists it. Both paths, and the honesty
 * line separating a creditable cascade grant from an uncreditable
 * deny-by-default non-event, live in `production-verification.ts`; this file
 * supplies the syntactic half and calls that predicate for the verdict.
 *
 * Also exposes the in-memory coverage derivation. Running this file directly
 * writes an ignored JSON report for inspection; runtime consumers never read it.
 */
import { loadSnapshot, type RulesEngine } from '../rules-language/load.ts';
import { surfaceRegistries } from '../registry/index.ts';
import {
  deriveConformanceGraph,
  indexConstructScopes,
  type ProductionVerdict,
} from './production-verification.ts';
import { assertFirestoreRulesOracleReplay } from './firestore-rules-oracle-replay.ts';
import { loadRulesLanguageScenarios } from './rules-language-scenarios.ts';

// ── Result shape ──────────────────────────────────────────────────────

export interface UnresolvedRef {
  /** What could not be attributed (e.g. `method:size`). */
  what: string;
  /** Why (e.g. `receiver type unknown, name ambiguous across map/list/set`). */
  reason: string;
}

export interface AnalyzeResult {
  /** Construct ids exercised (all present in the engine snapshot). */
  ids: Set<string>;
  /** Constructs seen but not attributable to a single snapshot id. */
  unresolved: UnresolvedRef[];
}

// ════════════════════════════════════════════════════════════════════
// FIRESTORE
// ════════════════════════════════════════════════════════════════════

export { analyzeFirestore } from './firestore-rules-analyzer.ts';
export { analyzeStorage } from './storage-rules-analyzer.ts';
export { analyzeRtdb } from './rtdb-rules-analyzer.ts';
import { analyzeFirestore } from './firestore-rules-analyzer.ts';
import { analyzeStorage } from './storage-rules-analyzer.ts';
import { analyzeRtdb } from './rtdb-rules-analyzer.ts';

export function analyze(engine: RulesEngine, source: string): AnalyzeResult {
  switch (engine) {
    case 'firestore':
      return analyzeFirestore(source);
    case 'storage':
      return analyzeStorage(source);
    case 'rtdb':
      return analyzeRtdb(source);
  }
}

// ════════════════════════════════════════════════════════════════════
// Computed coverage report (issue #185, step 2 exit criterion)
// ════════════════════════════════════════════════════════════════════

export interface ConstructCoverage {
  id: string;
  kind: string;
  /** The production-evidence conclusion. A divergence wins over every positive
   *  path, so a construct cannot remain in the verified numerator while a
   *  captured rules-engine row proves the simulator wrong about it. */
  verdict: ProductionVerdict;
  /** All scenario ids that exercise the construct. */
  exercisedBy: string[];
  /** SYNTACTIC verification: the subset of `exercisedBy` whose observation twin
   *  exists, so production's verdict on that exact ruleset was captured and
   *  replayed. */
  verifiedBy: string[];
  /** BEHAVIORAL verification: the `conforms` + `oracle-backed` rules-engine
   *  registry rows whose `constructs` scope lists this construct — production
   *  verdicts that can only be explained by it. The path an engine semantic with
   *  no source token (the RTDB cascades) is credited by; see
   *  production-verification.ts. Either list, non-empty, verifies the construct. */
  verifiedByRows: string[];
  /** Rules-engine rows that prove the simulator diverges on this construct. */
  divergedByRows?: string[];
  /** Mirrors the snapshot's `unattributable` (see rules-language/types.ts):
   *  present iff this construct can never be credited by static AST
   *  analysis. Such constructs are carried in `constructs` for the full
   *  audit trail but EXCLUDED from `totalConstructs` and the two coverage
   *  ratios below — counting a permanently-uncreditable construct in the
   *  denominator would put a ceiling on the trust number for a reason
   *  unrelated to real coverage gaps. An empty `exercisedBy`/`verifiedBy`
   *  here is expected forever, not a pending gap. */
  unattributable?: string;
}

export interface EngineCoverage {
  engine: RulesEngine;
  totalConstructs: number;
  exercisedConstructs: number;
  verifiedConstructs: number;
  /** exercised / total, 0..1 (analyzer-measured breadth over the corpus). */
  exercisedCoverage: number;
  /** verified / total, 0..1 — the trust number (production-confirmed). */
  verifiedCoverage: number;
  constructs: ConstructCoverage[];
  scenarioCount: number;
  verifiedScenarioCount: number;
  unresolved: Array<{ scenario: string; what: string; reason: string }>;
}

export interface CoverageReport {
  generatedNote: string;
  engines: EngineCoverage[];
}

const RULES_ENGINES: readonly RulesEngine[] = ['firestore', 'storage', 'rtdb'] as const;

export async function computeCoverageReport(): Promise<CoverageReport> {
  await assertFirestoreRulesOracleReplay();
  const engines: EngineCoverage[] = [];
  const scopes = indexConstructScopes(surfaceRegistries);
  for (const engine of RULES_ENGINES) {
    const snapshot = loadSnapshot(engine);
    const { scenarios, twinIds } = loadRulesLanguageScenarios(engine);
    const cov = new Map<string, ConstructCoverage>();
    for (const c of snapshot.constructs) {
      cov.set(c.id, {
        id: c.id,
        kind: c.kind,
        verdict: 'unverified',
        exercisedBy: [],
        verifiedBy: [],
        verifiedByRows: [],
        ...(c.unattributable ? { unattributable: c.unattributable } : {}),
      });
    }
    const unresolved: EngineCoverage['unresolved'] = [];
    for (const scenario of scenarios) {
      const result = analyze(engine, scenario.rules);
      const verified = twinIds.has(scenario.id);
      for (const id of result.ids) {
        const entry = cov.get(id);
        if (!entry) {
          // Analyzer produced an id absent from the snapshot — a real bug we
          // want loud, not silently dropped.
          throw new Error(
            `analyzer emitted id "${id}" for ${engine} scenario "${scenario.id}" that is not in the snapshot`,
          );
        }
        entry.exercisedBy.push(scenario.id);
        if (verified) entry.verifiedBy.push(scenario.id);
      }
      for (const u of result.unresolved) unresolved.push({ scenario: scenario.id, ...u });
    }
    const constructs = [...cov.values()];
    const graph = deriveConformanceGraph({
      scenariosByConstruct: new Map(
        constructs.map((construct) => [construct.id, construct.verifiedBy]),
      ),
      provingRowsByConstruct: scopes.provingRows,
      divergingRowsByConstruct: scopes.divergingRows,
    });
    for (const construct of constructs) {
      const fact = graph.factOf(construct.id);
      construct.verdict = fact.verdict;
      construct.verifiedByRows = [...fact.provingRows];
      if (fact.divergingRows.length > 0) {
        construct.divergedByRows = [...fact.divergingRows];
      }
    }
    // Permanently-unattributable constructs (see ConstructCoverage.unattributable)
    // are carried in `constructs` for the audit trail but excluded from the
    // denominator: they can never be credited by static AST analysis, so
    // counting them against the total would put an un-earnable ceiling on the
    // coverage ratios for a reason unrelated to real gaps.
    const attributable = constructs.filter((c) => !c.unattributable);
    const exercisedConstructs = attributable.filter((c) => c.exercisedBy.length > 0).length;
    // The shared graph verdict includes both positive paths and contamination.
    // Negative production evidence dominates, so only an explicit `verified`
    // verdict belongs in the trust numerator.
    const verifiedConstructs = attributable.filter((c) => c.verdict === 'verified').length;
    const total = attributable.length;
    engines.push({
      engine,
      totalConstructs: total,
      exercisedConstructs,
      verifiedConstructs,
      exercisedCoverage: total ? exercisedConstructs / total : 0,
      verifiedCoverage: total ? verifiedConstructs / total : 0,
      constructs,
      scenarioCount: scenarios.length,
      verifiedScenarioCount: scenarios.filter((s) => twinIds.has(s.id)).length,
      unresolved,
    });
  }
  return {
    generatedNote:
      'Verified coverage = production-verified snapshot constructs / total ATTRIBUTABLE snapshot constructs. A construct is production-verified by either positive evidence path in src/production-verification.ts: SYNTACTIC — `verifiedBy` lists >=1 corpus scenario that exercises it and has an observation twin; or BEHAVIORAL — `verifiedByRows` lists >=1 `conforms` + `oracle-backed` rules-engine row whose captured verdicts adjudicate it. Negative production evidence dominates both paths: any `diverged-documented` or `bug` rules-engine row in `divergedByRows` makes the construct `diverged` and removes it from the verified numerator until the finding is resolved. A construct carrying `unattributable` is retained for the audit trail but excluded from the denominator only where no source node or distinguishing verdict can ever attribute it. Regenerated by rules-language-analyzer.ts.',
    engines,
  };
}

export async function writeCoverageReport(): Promise<string> {
  const { writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'rules-language', 'coverage-report.json');
  const report = await computeCoverageReport();
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return outPath;
}

if (import.meta.main) {
  const outPath = await writeCoverageReport();
  const report = await computeCoverageReport();
  for (const e of report.engines) {
    console.log(
      `${e.engine}: exercised ${e.exercisedConstructs}/${e.totalConstructs} ` +
        `(${(e.exercisedCoverage * 100).toFixed(1)}%), verified ${e.verifiedConstructs}/${e.totalConstructs} ` +
        `(${(e.verifiedCoverage * 100).toFixed(1)}%) over ${e.scenarioCount} scenarios ` +
        `(${e.verifiedScenarioCount} with twins); ${e.unresolved.length} unresolved refs`,
    );
  }
  console.log(`Wrote ${outPath}`);
}
