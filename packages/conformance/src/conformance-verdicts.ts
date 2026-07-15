#!/usr/bin/env bun
/**
 * Derive the runtime verdict for every addressable conformance-graph node.
 *
 * This is deliberately a projection, not another authored catalog. Constructs
 * come from the rules-language snapshots; rows come from the registries. The
 * generated TypeScript is ignored by git and rebuilt before the CLI compiles,
 * so graph evidence remains the only source of truth and PRs contain no
 * mechanically regenerated data.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow } from '../registry/index.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';
import {
  RULES_ENGINE_SURFACES,
  deriveConformanceGraph,
  indexConstructScopes,
} from './production-verification.ts';
import { computeCapabilityReport, type CapabilityReport } from './rules-language-capability.ts';
import { computeCoverageReport, type CoverageReport } from './rules-language-analyzer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_TS_PATH = join(
  HERE,
  '..',
  '..',
  'cli',
  'src',
  'assurance',
  '.generated',
  'conformance-verdicts.ts',
);

export type ConformanceVerdict = 'supported' | 'qualified' | 'unsupported';

interface ConstructReportEntry {
  id: string;
  classification: 'implemented' | 'unsupported' | 'error' | 'unprobeable';
}

export interface ConformanceGraph {
  snapshotStatus: Map<string, string>;
  probeClass: Map<string, ConstructReportEntry['classification']>;
  verifiedBy: Map<string, string[]>;
  rows: Map<string, CompatibilityRow>;
  divergedBy: Map<string, string[]>;
  oracleProvedBy: Map<string, string[]>;
}

export interface ConformanceEvidence {
  graph: ConformanceGraph;
  capabilityReport: CapabilityReport;
  coverageReport: CoverageReport;
}

export async function deriveConformanceEvidence(): Promise<ConformanceEvidence> {
  const snapshotStatus = new Map<string, string>();
  for (const snapshot of Object.values(loadAllSnapshots())) {
    for (const construct of snapshot.constructs) snapshotStatus.set(construct.id, construct.status);
  }

  const probeClass = new Map<string, ConstructReportEntry['classification']>();
  const capabilityReport = computeCapabilityReport();
  for (const engine of capabilityReport.engines) {
    for (const construct of engine.constructs) probeClass.set(construct.id, construct.classification);
  }

  const verifiedBy = new Map<string, string[]>();
  const coverageReport = await computeCoverageReport();
  for (const engine of coverageReport.engines) {
    for (const construct of engine.constructs) verifiedBy.set(construct.id, construct.verifiedBy ?? []);
  }

  const rows = new Map<string, CompatibilityRow>();
  for (const registry of surfaceRegistries) {
    for (const block of registry.blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.rows) rows.set(row.id, row);
    }
  }
  const { provingRows, divergingRows } = indexConstructScopes(surfaceRegistries);
  const graph = {
    snapshotStatus,
    probeClass,
    verifiedBy,
    rows,
    divergedBy: divergingRows,
    oracleProvedBy: provingRows,
  };
  return { graph, capabilityReport, coverageReport };
}

export async function loadConformanceGraph(): Promise<ConformanceGraph> {
  return (await deriveConformanceEvidence()).graph;
}

export function validationProblems(graph: ConformanceGraph): string[] {
  const problems: string[] = [];
  for (const row of graph.rows.values()) {
    for (const construct of row.constructs ?? []) {
      if (!graph.snapshotStatus.has(construct)) {
        problems.push(`registry row ${row.id} lists construct "${construct}", which no rules-language snapshot enumerates`);
      }
    }
    if (
      RULES_ENGINE_SURFACES.has(row.surface) &&
      (row.status === 'diverged-documented' || row.status === 'bug') &&
      (!row.constructs || row.constructs.length === 0)
    ) {
      problems.push(
        `registry row ${row.id} is "${row.status}" on rules-engine surface ${row.surface} but declares no 'constructs' scope; a divergence with no scope contaminates no node`,
      );
    }
  }
  for (const id of graph.snapshotStatus.keys()) {
    if (graph.rows.has(id)) problems.push(`conformance node id "${id}" is both a construct and a registry row`);
  }
  return problems;
}

export function deriveConstructVerdict(graph: ConformanceGraph, id: string): ConformanceVerdict {
  if (!graph.snapshotStatus.has(id)) return 'unsupported';
  const snapshot = graph.snapshotStatus.get(id);
  const probe = graph.probeClass.get(id);
  if (snapshot === 'rejected' || probe === undefined || probe === 'unsupported' || probe === 'error') {
    return 'unsupported';
  }
  if ((graph.divergedBy.get(id)?.length ?? 0) > 0) return 'unsupported';
  if (snapshot === 'unprobed' || snapshot === 'unprobeable' || probe === 'unprobeable') return 'qualified';

  const productionFact = deriveConformanceGraph({
    scenariosByConstruct: graph.verifiedBy,
    provingRowsByConstruct: graph.oracleProvedBy,
    divergingRowsByConstruct: graph.divergedBy,
  }).factOf(id);
  return productionFact.verdict === 'verified' ? 'supported' : 'qualified';
}

export function deriveRegistryRowVerdict(graph: ConformanceGraph, id: string): ConformanceVerdict {
  const row = graph.rows.get(id);
  if (!row) return 'unsupported';
  if (row.status === 'bug' || row.status === 'unsupported') return 'unsupported';
  if (row.status === 'diverged-documented') {
    return RULES_ENGINE_SURFACES.has(row.surface) ? 'unsupported' : 'qualified';
  }
  if (row.status === 'unverified') return 'qualified';
  return 'supported';
}

export function deriveAllNodeVerdicts(
  graph: ConformanceGraph,
): Readonly<Record<string, ConformanceVerdict>> {
  const problems = validationProblems(graph);
  if (problems.length > 0) throw new Error(`conformance graph is not resolvable:\n  - ${problems.join('\n  - ')}`);

  const verdicts: Record<string, ConformanceVerdict> = {};
  for (const id of [...graph.snapshotStatus.keys()].sort()) verdicts[id] = deriveConstructVerdict(graph, id);
  for (const id of [...graph.rows.keys()].sort()) verdicts[id] = deriveRegistryRowVerdict(graph, id);
  return verdicts;
}

export function renderConformanceVerdicts(verdicts: Readonly<Record<string, ConformanceVerdict>>): string {
  const lines = [
    '// GENERATED FILE. Do not edit or commit.',
    '// Regenerate: bun run compat:conformance',
    '// Source: packages/conformance/src/conformance-verdicts.ts',
    "export type ConformanceVerdict = 'supported' | 'qualified' | 'unsupported';",
    '',
    'export const CONFORMANCE_VERDICTS = {',
  ];
  for (const id of Object.keys(verdicts).sort()) lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(verdicts[id])},`);
  lines.push('} as const satisfies Readonly<Record<string, ConformanceVerdict>>;', '');
  return lines.join('\n');
}
