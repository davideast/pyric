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

/** Stores each distinct value once and hands out its index. Many features
 * share one registry row, so the same caveat text repeats across distant
 * records where gzip cannot see it, and the short enum fields repeat on
 * every row. */
class InternTable<T> {
  readonly values: T[] = [];
  private readonly indexByKey = new Map<string, number>();

  index(value: T): number {
    const key = JSON.stringify(value);
    const known = this.indexByKey.get(key);
    if (known !== undefined) return known;
    const nextIndex = this.values.length;
    this.values.push(value);
    this.indexByKey.set(key, nextIndex);
    return nextIndex;
  }
}

/** One support as a positional row. The order here, the generated
 * `SupportRow` type, and `DECODE_SUPPORTS` must agree. */
type SupportRow = [
  feature: string,
  surface: number,
  importPaths: number,
  evidenceSlug: number,
  availability: number,
  fidelity: number,
  assurance: number,
  summary: string,
  caveats: number[],
];

interface SupportTables {
  surfaces: InternTable<string>;
  importPaths: InternTable<readonly string[]>;
  evidenceSlugs: InternTable<string>;
  availabilities: InternTable<string>;
  fidelities: InternTable<string>;
  assurances: InternTable<string>;
  caveats: InternTable<string>;
}

function emptyTables(): SupportTables {
  return {
    surfaces: new InternTable(),
    importPaths: new InternTable(),
    evidenceSlugs: new InternTable(),
    availabilities: new InternTable(),
    fidelities: new InternTable(),
    assurances: new InternTable(),
    caveats: new InternTable(),
  };
}

function toRow(support: FeatureSupport, tables: SupportTables): SupportRow {
  return [
    support.feature,
    tables.surfaces.index(support.surface),
    tables.importPaths.index(support.importPaths),
    tables.evidenceSlugs.index(support.evidenceSlug),
    tables.availabilities.index(support.availability),
    tables.fidelities.index(support.fidelity),
    tables.assurances.index(support.assurance),
    support.summary,
    support.caveats.map((caveat) => tables.caveats.index(caveat)),
  ];
}

function tableConstant(name: string, elementType: string, table: InternTable<unknown>): string {
  return `const ${name}: readonly ${elementType}[] = ${JSON.stringify(table.values)};`;
}

const GENERATED_SUPPORT_ROW_TYPE = 'type SupportRow = readonly [feature: string, surface: number, importPaths: number, evidenceSlug: number, availability: number, fidelity: number, assurance: number, summary: string, caveats: readonly number[]];';

/** Decodes each row into the same object, with the same key order, that the
 * model holds. Every row gets its own import path and caveat arrays. */
const DECODE_SUPPORTS = [
  'export const CONFORMANCE_SUPPORTS: readonly BrowserFeatureSupport[] = SUPPORT_ROWS.map(',
  '  ([feature, surface, importPaths, evidenceSlug, availability, fidelity, assurance, summary, caveats]) => ({',
  '    feature,',
  '    surface: SURFACES[surface]!,',
  '    importPaths: [...IMPORT_PATHS[importPaths]!],',
  '    evidenceSlug: EVIDENCE_SLUGS[evidenceSlug]!,',
  '    availability: AVAILABILITY_VALUES[availability]!,',
  '    fidelity: FIDELITY_VALUES[fidelity]!,',
  '    assurance: ASSURANCE_VALUES[assurance]!,',
  '    summary,',
  '    caveats: caveats.map((index) => CAVEAT_TEXT[index]!),',
  '  }),',
  ');',
].join('\n');

/** Render the deliberately compact browser projection. Claims and their
 * evidence chains stay in the Node projection. Each support is a positional
 * row whose repeated fields point into small tables, and the module decodes
 * the rows back into whole answers. Caveats ship whole, and for a registry
 * row that does not conform they include the row's evidence text. */
export function renderBrowserQuery(model: ConformanceModel): string {
  const tables = emptyTables();
  const rows = model.supports.map((support) => toRow(support, tables));
  return [
    ...sharedHeader('// Source: the central conformance model; claims and their evidence chains remain Node-only.', model.supports),
    'export interface BrowserFeatureSupport { feature: string; surface: DeveloperSurface; importPaths: readonly string[]; evidenceSlug: string; availability: Availability; fidelity: Fidelity; assurance: Assurance; summary: string; caveats: readonly string[]; }',
    tableConstant('SURFACES', 'DeveloperSurface', tables.surfaces),
    tableConstant('IMPORT_PATHS', '(readonly string[])', tables.importPaths),
    tableConstant('EVIDENCE_SLUGS', 'string', tables.evidenceSlugs),
    tableConstant('AVAILABILITY_VALUES', 'Availability', tables.availabilities),
    tableConstant('FIDELITY_VALUES', 'Fidelity', tables.fidelities),
    tableConstant('ASSURANCE_VALUES', 'Assurance', tables.assurances),
    tableConstant('CAVEAT_TEXT', 'string', tables.caveats),
    GENERATED_SUPPORT_ROW_TYPE,
    `const SUPPORT_ROWS: readonly SupportRow[] = ${JSON.stringify(rows)};`,
    DECODE_SUPPORTS,
    '',
    QUERY_RUNTIME_SOURCE,
    '',
  ].join('\n');
}
