/**
 * Shared diagnostic envelope, deterministic ordering, and fail-gate policy
 * across Firestore, Realtime Database, and Cloud Storage assurance checks.
 */

import type { AssuranceService, ResourcePattern } from './resource-pattern.js';

export type DiagnosticCertainty = 'proven-counterexample' | 'static-proof' | 'heuristic';
export type DiagnosticSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface DiagnosticRuntimeSite {
  readonly source: string;
  readonly concretePath?: string;
}

export interface AssuranceDiagnostic {
  readonly id: string;
  readonly code: string;
  readonly service: AssuranceService;
  readonly resourceId: string;
  readonly severity: DiagnosticSeverity;
  readonly certainty: DiagnosticCertainty;
  readonly message: string;
  readonly resource?: ResourcePattern;
  readonly codeSite?: { readonly source: string; readonly through?: string };
  readonly ruleSite?: { readonly source: string; readonly expression?: string };
  readonly runtimeSite?: DiagnosticRuntimeSite;
  readonly witness?: readonly unknown[];
  readonly remediation?: string;
}

export interface DiagnosticFailPolicy {
  readonly minSeverity?: DiagnosticSeverity;
  readonly includeHeuristic?: boolean;
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CERTAINTY_ORDER: Record<DiagnosticCertainty, number> = {
  'proven-counterexample': 0,
  'static-proof': 1,
  heuristic: 2,
};

function compareLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareAssuranceDiagnostics(a: AssuranceDiagnostic, b: AssuranceDiagnostic): number {
  const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severityDiff !== 0) return severityDiff;

  const certaintyDiff = CERTAINTY_ORDER[a.certainty] - CERTAINTY_ORDER[b.certainty];
  if (certaintyDiff !== 0) return certaintyDiff;

  const serviceDiff = compareLexicographic(a.service, b.service);
  if (serviceDiff !== 0) return serviceDiff;

  const resourceDiff = compareLexicographic(a.resourceId, b.resourceId);
  if (resourceDiff !== 0) return resourceDiff;

  const codeDiff = compareLexicographic(a.code, b.code);
  if (codeDiff !== 0) return codeDiff;

  const sourceA = a.codeSite?.source ?? '';
  const sourceB = b.codeSite?.source ?? '';
  const sourceDiff = compareLexicographic(sourceA, sourceB);
  if (sourceDiff !== 0) return sourceDiff;

  return compareLexicographic(a.id, b.id);
}

export function allocateDiagnosticId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  let suffix = 2;
  while (usedIds.has(`${baseId}#${suffix}`)) {
    suffix += 1;
  }
  const id = `${baseId}#${suffix}`;
  usedIds.add(id);
  return id;
}

export function buildCodeSite(
  source: string,
  through?: string,
): { source: string; through?: string } {
  const codeSite: { source: string; through?: string } = { source };
  if (through !== undefined) codeSite.through = through;
  return codeSite;
}

export function sortAssuranceDiagnostics(
  diagnostics: readonly AssuranceDiagnostic[],
): AssuranceDiagnostic[] {
  return [...diagnostics].sort(compareAssuranceDiagnostics);
}

export function shouldFailOnDiagnostic(
  diagnostic: AssuranceDiagnostic,
  failOn?: DiagnosticFailPolicy,
): boolean {
  const includeHeuristic = failOn?.includeHeuristic === true;
  if (diagnostic.certainty === 'heuristic' && !includeHeuristic) {
    return false;
  }
  const minSeverity = failOn?.minSeverity ?? 'low';
  return SEVERITY_ORDER[diagnostic.severity] <= SEVERITY_ORDER[minSeverity];
}
