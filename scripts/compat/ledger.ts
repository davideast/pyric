import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCompatibilityRows, observationExceptions, surfaceDescriptors, surfaceRegistries, type CompatibilityRow, type Surface } from './registry/index.ts';
import { generatedRowLineNumbers } from './generate-docs.ts';

export type { Automation, CompatibilityRow, CompatStatus, OracleConformanceCheck, Surface, SurfaceDescriptor } from './registry/index.ts';

export interface Observation {
  file: string;
  name: string;
  matrixRow: string;
  rowIds: string[];
  observedAt?: string;
  fbSdkVersion?: string;
  behavior: Record<string, unknown>;
  raw: Record<string, unknown>;
}

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
export const REPO_ROOT = join(HERE, '..', '..');
export const OBS_DIR = join(REPO_ROOT, 'scripts', 'oracle', 'observations');

export function repoRel(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

export function loadObservations(): Observation[] {
  return readdirSync(OBS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as Record<string, unknown>;
      const name = String(raw.name ?? file.replace(/\.json$/, ''));
      const matrixRow = String(raw.matrixRow ?? '');
      return {
        file,
        name,
        matrixRow,
        rowIds: Array.isArray(raw.rowIds) ? raw.rowIds.map(String) : [],
        observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : undefined,
        fbSdkVersion: typeof raw.fbSdkVersion === 'string' ? raw.fbSdkVersion : undefined,
        behavior: (raw.behavior && typeof raw.behavior === 'object' ? raw.behavior : {}) as Record<string, unknown>,
        raw,
      } satisfies Observation;
    });
}

function generatedLocations(): Map<string, { file: string; line: number }> {
  const out = new Map<string, { file: string; line: number }>();
  for (const surface of surfaceRegistries) {
    const lines = generatedRowLineNumbers(surface);
    for (const [id, line] of lines) out.set(id, { file: surface.compatPath, line });
  }
  return out;
}

export function buildCompatibilityLedger(): CompatibilityLedger {
  const observations = loadObservations();
  const locations = generatedLocations();
  const entries = allCompatibilityRows.map((row) => {
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
 * scripts/oracle/audit.ts, and summarizeLedger so the definition can't drift.
 */
export function highRiskUnverifiedRows(ledger: CompatibilityLedger): RegistryEntry[] {
  return ledger.entries
    .filter((e) => e.isConforming && e.riskScore >= 2 && e.automation === 'unverified')
    .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));
}

export function summarizeLedger(ledger: CompatibilityLedger) {
  const entries = ledger.entries;
  const bySurface = Object.fromEntries(
    surfaceDescriptors.map((d) => [d.surface, entries.filter((e) => e.surface === d.surface).length]),
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
    observations: ledger.observations.length,
    orphanObservations: ledger.orphanObservations.length,
    conformanceChecks,
  };
}
