import { readFileSync } from 'node:fs';
import type { ConformanceModel } from './conformance-model.ts';

const QUERY_RUNTIME_SOURCE = readFileSync(new URL('./can-i-use-query.ts', import.meta.url), 'utf8').trim();

export function renderCliQuery(model: ConformanceModel): string {
  const surfaces = [...new Set(model.supports.map(({ surface }) => surface))].sort();
  const surfaceUnion = surfaces.map((surface) => JSON.stringify(surface)).join(' | ');
  return [
    '// GENERATED FILE. Do not edit or commit.',
    '// Regenerate: bun run compat:conformance',
    '// Source: the central conformance model and its canonical can-i-use-query runtime.',
    `export type DeveloperSurface = ${surfaceUnion};`,
    "export type Availability = 'available' | 'unavailable' | 'deferred' | 'out-of-scope';",
    "export type Fidelity = 'conforms' | 'diverged' | 'bug' | 'unsupported' | 'unverified' | 'not-applicable';",
    "export type Assurance = 'eligible' | 'qualified' | 'ineligible' | 'not-applicable';",
    "export type FeatureClaimKind = 'runtime-export' | 'type-export' | 'registry-row' | 'rules-construct';",
    'export interface FeatureClaim { id: string; kind: FeatureClaimKind; surface: string; behavior: string; status: string; evidence: readonly string[]; assurance: Assurance; }',
    'export interface FeatureSupport { feature: string; surface: DeveloperSurface; importPaths: readonly string[]; evidenceSlug: string; availability: Availability; fidelity: Fidelity; assurance: Assurance; summary: string; caveats: readonly string[]; claims: readonly FeatureClaim[]; }',
    'export interface ImportEvidence { importPath: string; surface: DeveloperSurface; evidenceSlug: string; }',
    `export const CONFORMANCE_SUPPORTS: readonly FeatureSupport[] = ${JSON.stringify(model.supports)};`,
    `export const CONFORMANCE_IMPORT_EVIDENCE: readonly ImportEvidence[] = ${JSON.stringify(model.importEvidence)};`,
    '',
    QUERY_RUNTIME_SOURCE,
    '',
  ].join('\n');
}

/** Render the deliberately compact browser projection. Claims and their full
 * evidence chains stay in the Node projection; browser agents need only the
 * answer, caveats, and route back to generated evidence. */
export function renderBrowserQuery(model: ConformanceModel): string {
  const supports = model.supports.map(({ claims: _claims, ...support }) => support);
  const surfaces = [...new Set(supports.map(({ surface }) => surface))].sort();
  const surfaceUnion = surfaces.map((surface) => JSON.stringify(surface)).join(' | ');
  return [
    '// GENERATED FILE. Do not edit or commit.',
    '// Regenerate: bun run compat:conformance',
    '// Source: the central conformance model; full evidence remains Node-only.',
    `export type DeveloperSurface = ${surfaceUnion};`,
    "export type Availability = 'available' | 'unavailable' | 'deferred' | 'out-of-scope';",
    "export type Fidelity = 'conforms' | 'diverged' | 'bug' | 'unsupported' | 'unverified' | 'not-applicable';",
    "export type Assurance = 'eligible' | 'qualified' | 'ineligible' | 'not-applicable';",
    'export interface BrowserFeatureSupport { feature: string; surface: DeveloperSurface; importPaths: readonly string[]; evidenceSlug: string; availability: Availability; fidelity: Fidelity; assurance: Assurance; summary: string; caveats: readonly string[]; }',
    `export const CONFORMANCE_SUPPORTS: readonly BrowserFeatureSupport[] = ${JSON.stringify(supports)};`,
    '',
    QUERY_RUNTIME_SOURCE,
    '',
  ].join('\n');
}
