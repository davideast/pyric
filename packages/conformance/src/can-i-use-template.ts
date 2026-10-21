import { readFileSync } from 'node:fs';
import { ASSURANCES, AVAILABILITIES, FIDELITIES, type ConformanceModel, type FeatureSupport } from './conformance-model.ts';

const QUERY_RUNTIME_SOURCE = readFileSync(new URL('./can-i-use-query.ts', import.meta.url), 'utf8').trim();

function unionOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' | ');
}

function sharedHeader(sourceNote: string, supports: readonly { surface: string }[]): string[] {
  const surfaces = [...new Set(supports.map(({ surface }) => surface))].sort();
  return [
    '// GENERATED FILE. Do not edit or commit.',
    '// Regenerate: bun run compat:conformance',
    sourceNote,
    `export type DeveloperSurface = ${surfaces.map((surface) => JSON.stringify(surface)).join(' | ')};`,
    `export type Availability = ${unionOf(AVAILABILITIES)};`,
    `export type Fidelity = ${unionOf(FIDELITIES)};`,
    `export type Assurance = ${unionOf(ASSURANCES)};`,
  ];
}

export function renderCliQuery(model: ConformanceModel): string {
  return [
    ...sharedHeader('// Source: the central conformance model and its canonical can-i-use-query runtime.', model.supports),
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

interface CaveatTable {
  caveatText: string[];
  supports: Array<Omit<FeatureSupport, 'claims' | 'caveats'> & { caveats: number[] }>;
}

/** Many features share one registry row, so the same caveat text repeats
 * across distant records where gzip cannot see it. Store each text once and
 * let features reference it by index; the module rebuilds the same answers. */
function internCaveats(model: ConformanceModel): CaveatTable {
  const caveatText: string[] = [];
  const indexByText = new Map<string, number>();
  const intern = (text: string): number => {
    const known = indexByText.get(text);
    if (known !== undefined) return known;
    indexByText.set(text, caveatText.length);
    return caveatText.push(text) - 1;
  };
  const supports = model.supports.map(({ claims: _claims, caveats, ...answer }) => ({ ...answer, caveats: caveats.map(intern) }));
  return { caveatText, supports };
}

/** Render the deliberately compact browser projection. Claims and their full
 * evidence chains stay in the Node projection; browser agents need only the
 * answer, caveats, and route back to generated evidence. */
export function renderBrowserQuery(model: ConformanceModel): string {
  const { caveatText, supports } = internCaveats(model);
  return [
    ...sharedHeader('// Source: the central conformance model; full evidence remains Node-only.', supports),
    'export interface BrowserFeatureSupport { feature: string; surface: DeveloperSurface; importPaths: readonly string[]; evidenceSlug: string; availability: Availability; fidelity: Fidelity; assurance: Assurance; summary: string; caveats: readonly string[]; }',
    `const CAVEAT_TEXT: readonly string[] = ${JSON.stringify(caveatText)};`,
    `const INTERNED_SUPPORTS: readonly (Omit<BrowserFeatureSupport, 'caveats'> & { caveats: readonly number[] })[] = ${JSON.stringify(supports)};`,
    'export const CONFORMANCE_SUPPORTS: readonly BrowserFeatureSupport[] = INTERNED_SUPPORTS.map((support) => ({ ...support, caveats: support.caveats.map((index) => CAVEAT_TEXT[index]!) }));',
    '',
    QUERY_RUNTIME_SOURCE,
    '',
  ].join('\n');
}
