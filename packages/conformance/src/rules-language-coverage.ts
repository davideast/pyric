import { loadSnapshot, type RulesEngine } from '../rules-language/load.ts';
import { surfaceRegistries } from '../registry/index.ts';
import { assertFirestoreRulesOracleReplay } from './firestore-rules-oracle-replay.ts';
import { analyze } from './rules-language-analyzer.ts';
import { loadRulesLanguageScenarios } from './rules-language-scenarios.ts';
import {
  deriveConformanceGraph,
  indexConstructScopes,
  type ProductionVerdict,
} from './production-verification.ts';

export interface ConstructCoverage {
  id: string;
  kind: string;
  verdict: ProductionVerdict;
  exercisedBy: string[];
  verifiedBy: string[];
  verifiedByRows: string[];
  divergedByRows?: string[];
  unattributable?: string;
}

export interface EngineCoverage {
  engine: RulesEngine;
  totalConstructs: number;
  exercisedConstructs: number;
  verifiedConstructs: number;
  exercisedCoverage: number;
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

const RULES_ENGINES: readonly RulesEngine[] = ['firestore', 'storage', 'rtdb'];

/** Derive production-backed construct coverage after replaying current evidence. */
export async function computeCoverageReport(): Promise<CoverageReport> {
  await assertFirestoreRulesOracleReplay();
  const engines: EngineCoverage[] = [];
  const scopes = indexConstructScopes(surfaceRegistries);
  for (const engine of RULES_ENGINES) {
    const snapshot = loadSnapshot(engine);
    const { scenarios, twinIds } = loadRulesLanguageScenarios(engine);
    const coverage = new Map<string, ConstructCoverage>();
    for (const construct of snapshot.constructs) {
      coverage.set(construct.id, {
        id: construct.id,
        kind: construct.kind,
        verdict: 'unverified',
        exercisedBy: [],
        verifiedBy: [],
        verifiedByRows: [],
        ...(construct.unattributable ? { unattributable: construct.unattributable } : {}),
      });
    }
    const unresolved: EngineCoverage['unresolved'] = [];
    for (const scenario of scenarios) {
      const result = analyze(engine, scenario.rules);
      const verified = twinIds.has(scenario.id);
      for (const id of result.ids) {
        const entry = coverage.get(id);
        if (!entry) {
          throw new Error(`analyzer emitted id "${id}" for ${engine} scenario "${scenario.id}" that is not in the snapshot`);
        }
        entry.exercisedBy.push(scenario.id);
        if (verified) entry.verifiedBy.push(scenario.id);
      }
      for (const item of result.unresolved) unresolved.push({ scenario: scenario.id, ...item });
    }
    const constructs = [...coverage.values()];
    const graph = deriveConformanceGraph({
      scenariosByConstruct: new Map(constructs.map((construct) => [construct.id, construct.verifiedBy])),
      provingRowsByConstruct: scopes.provingRows,
      divergingRowsByConstruct: scopes.divergingRows,
    });
    for (const construct of constructs) {
      const fact = graph.factOf(construct.id);
      construct.verdict = fact.verdict;
      construct.verifiedByRows = [...fact.provingRows];
      if (fact.divergingRows.length > 0) construct.divergedByRows = [...fact.divergingRows];
    }
    const attributable = constructs.filter((construct) => !construct.unattributable);
    const exercisedConstructs = attributable.filter((construct) => construct.exercisedBy.length > 0).length;
    const verifiedConstructs = attributable.filter((construct) => construct.verdict === 'verified').length;
    const totalConstructs = attributable.length;
    engines.push({
      engine,
      totalConstructs,
      exercisedConstructs,
      verifiedConstructs,
      exercisedCoverage: totalConstructs ? exercisedConstructs / totalConstructs : 0,
      verifiedCoverage: totalConstructs ? verifiedConstructs / totalConstructs : 0,
      constructs,
      scenarioCount: scenarios.length,
      verifiedScenarioCount: scenarios.filter((scenario) => twinIds.has(scenario.id)).length,
      unresolved,
    });
  }
  return {
    generatedNote: 'Verified coverage = production-verified snapshot constructs / total ATTRIBUTABLE snapshot constructs. Positive syntactic or behavioral evidence can verify a construct; negative production evidence dominates and removes it from the numerator. Permanently unattributable constructs remain visible but are excluded from the denominator.',
    engines,
  };
}

export async function writeCoverageReport(): Promise<string> {
  const { writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'rules-language', 'coverage-report.json');
  writeFileSync(outPath, `${JSON.stringify(await computeCoverageReport(), null, 2)}\n`, 'utf8');
  return outPath;
}

if (import.meta.main) {
  const outPath = await writeCoverageReport();
  const report = await computeCoverageReport();
  for (const engine of report.engines) {
    console.log(`${engine.engine}: exercised ${engine.exercisedConstructs}/${engine.totalConstructs} (${(engine.exercisedCoverage * 100).toFixed(1)}%), verified ${engine.verifiedConstructs}/${engine.totalConstructs} (${(engine.verifiedCoverage * 100).toFixed(1)}%) over ${engine.scenarioCount} scenarios (${engine.verifiedScenarioCount} with twins); ${engine.unresolved.length} unresolved refs`);
  }
  console.log(`Wrote ${outPath}`);
}
