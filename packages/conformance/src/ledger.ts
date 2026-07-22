import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CompatibilityRow, type Surface } from '../registry/index.ts';
import { generatedRowLineNumbers } from './generate-docs.ts';
import type { ConformanceModel } from './conformance-model.ts';
export { loadObservations, type Observation } from '../observations/load.ts';
import type { Observation } from '../observations/load.ts';

export type { Automation, CompatibilityRow, CompatStatus, OracleConformanceCheck, Surface } from '../registry/index.ts';
export type { SurfaceDescriptor } from '../surfaces/types.ts';

export interface RegistryEntry extends CompatibilityRow {
  matrix: Surface;
  file: string;
  line: number;
  hasOracle: boolean;
  hasTestEvidence: boolean;
  isConforming: boolean;
}

export interface CompatibilityLedger {
  entries: RegistryEntry[];
  observations: Observation[];
  observationExceptions: Record<string, string>;
  orphanObservations: Observation[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');

export function repoRel(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

function generatedLocations(model: ConformanceModel): Map<string, { file: string; line: number }> {
  const out = new Map<string, { file: string; line: number }>();
  for (const surface of model.documentation.registries) {
    const lines = generatedRowLineNumbers(surface, model.documentation);
    for (const [id, line] of lines) out.set(id, { file: surface.compatPath, line });
  }
  return out;
}

export function buildCompatibilityLedger(model: ConformanceModel): CompatibilityLedger {
  const observations = [...model.evidence.observations];
  const observationExceptions = { ...model.evidence.observationExceptions };
  const locations = generatedLocations(model);
  const entries = model.documentation.rows.map((row) => {
    const location = locations.get(row.id) ?? { file: '', line: 0 };
    return {
      ...row,
      matrix: row.surface,
      file: location.file,
      line: location.line,
      hasOracle: row.oracleObservations.length > 0,
      hasTestEvidence: row.conformanceTests.length > 0,
      isConforming: row.status === 'conforms',
    } satisfies RegistryEntry;
  });

  const referencedObservations = new Set(entries.flatMap((row) => row.oracleObservations));
  for (const row of entries) for (const check of row.conformanceChecks ?? []) referencedObservations.add(check.observation);

  const orphanObservations = observations.filter((obs) => {
    if (observationExceptions[obs.name]) return false;
    return !referencedObservations.has(obs.name);
  });

  return { entries, observations, observationExceptions, orphanObservations };
}

/**
 * The audit-worklist query: rows that claim conformance with meaningful risk
 * but no oracle/test evidence or explicit exception. Shared by report.ts,
 * packages/conformance/src/audit.ts, and summarizeLedger so the definition can't drift.
 */
export function highRiskUnverifiedRows(ledger: CompatibilityLedger): RegistryEntry[] {
  return ledger.entries
    .filter((e) => e.isConforming && e.riskScore >= 2 && e.automation === 'unverified')
    .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));
}

/**
 * Climb-risk tokens that name an evidence tier BELOW a conformance claim:
 * the behavior was never observed in production, or an observation is cited
 * but the conformance suite does not replay it. Registries authored under
 * CDD (messaging, functions-rtdb) attach these while a row climbs.
 */
const EVIDENCE_TIER_GAP_RISKS = ['unobserved', 'cited-not-replayed'];

/**
 * The evidence-tier worklist: sibling of `highRiskUnverifiedRows` for rows
 * that are invisible to it because they were flipped straight to `conforms`
 * with `automation: 'unit-backed'`. A unit-backed green row whose own risk
 * taxonomy says its behavior is unobserved (or cited but not replayed) is a
 * claim stated stronger than its evidence; the audit gate ratchets these the
 * same way it ratchets high-risk unverified rows.
 *
 * Deliberately scoped to the declared climb-risk tokens: the mature
 * registries' unit-backed rows (auth, firestore, rtdb, storage) carry
 * assertion-shaped risk like "structural / routing-only claim" whose claims
 * their unit suites do exercise, and they stay out of this worklist.
 */
export function evidenceTierGapRows(ledger: CompatibilityLedger): RegistryEntry[] {
  return ledger.entries
    .filter(
      (e) =>
        e.isConforming &&
        e.automation === 'unit-backed' &&
        e.risk.some((token) => EVIDENCE_TIER_GAP_RISKS.includes(token)),
    )
    .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));
}

export function summarizeLedger(ledger: CompatibilityLedger, model: ConformanceModel) {
  const entries = ledger.entries;
  const bySurface = Object.fromEntries(
    model.documentation.descriptors.map((d) => [d.surface, entries.filter((e) => e.surface === d.surface).length]),
  ) as Record<Surface, number>;
  const explicitExceptions = entries.filter((e) => ['sandbox-only', 'playground-only', 'type-backed', 'unsupported'].includes(e.automation));
  const conformanceChecks = entries.reduce((sum, row) => sum + (row.conformanceChecks?.length ?? 0), 0);
  return {
    totalRows: entries.length,
    bySurface,
    conformingRows: entries.filter((e) => e.isConforming).length,
    oracleBackedRows: entries.filter((e) => e.hasOracle).length,
    unitBackedRows: entries.filter((e) => e.automation === 'unit-backed').length,
    explicitExceptionRows: explicitExceptions.length,
    unsupportedRows: entries.filter((e) => e.automation === 'unsupported').length,
    unverifiedRows: entries.filter((e) => e.automation === 'unverified').length,
    highRiskUnverifiedRows: highRiskUnverifiedRows(ledger).length,
    evidenceTierGapRows: evidenceTierGapRows(ledger).length,
    observations: ledger.observations.length,
    orphanObservations: ledger.orphanObservations.length,
    conformanceChecks,
  };
}
