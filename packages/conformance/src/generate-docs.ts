#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CompatibilityRow, type CompatibilitySurfaceRegistry, type CompatStatus } from '../registry/index.ts';
import {
  deriveConformanceModel,
  type ConformanceModel,
} from './conformance-model.ts';
import type { SurfaceCensus } from './surface-census.ts';
import { compatibilityHref } from './docs-routes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const GENERATED_HEADER = '<!-- Generated from the conformance model (registry rows + surface contracts). Do not edit by hand; run bun run compat:generate. -->';

/**
 * Canonical virtual identifier for the generated central scoreboard. Authored
 * docs no longer live under packages/pyric/docs, but this string is a neutral
 * virtual path, not a filesystem target: it seeds the stable public slug
 * (docs-routes.compatibilitySlug) and the relative scoreboard hrefs the site
 * rewrites. It must not change, or the published /docs/ URLs would move.
 */
export const SCOREBOARD_PATH = 'packages/pyric/docs/conformance/SCORES.md';

export type DocumentationProjection = ConformanceModel['documentation'];

/** Display glyphs for the typed status enum — rendering only, never parsed. */
export const STATUS_GLYPHS: Record<CompatStatus, string> = {
  'conforms': '✓',
  'diverged-documented': '⚠',
  'bug': '✗',
  'unsupported': '—',
  'unverified': '?',
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

// ── Public API surface coverage ─────────────────────────────────────────────

/** One surface's mapping onto the behavior ledger + surface census. */
interface SurfaceScoreSpec {
  label: string;
  /** Live census surface keys that contribute surface-coverage % (mirror only). */
  censusServices: string[];
  /** Label used when this registry has no export-census denominator. */
  noCensusKind?: 'native' | 'integration';
}

/** Derive scoring ownership from the same descriptors that own registry rows
 * and census surfaces. A new descriptor therefore cannot disappear from the
 * scoreboard behind an unmodified hand-maintained list. */
function scoreSpec(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): SurfaceScoreSpec {
  const descriptors = projection.descriptors.filter(({ registryKey }) => registryKey === surface.surface);
  if (descriptors.length === 0) throw new Error(`No surface descriptors own compatibility registry '${surface.surface}'`);
  const ownedServices = [...new Set(descriptors.map(({ surface: owner }) => owner))];
  const unownedRows = surface.blocks
    .flatMap((block) => block.kind === 'table' ? block.rows : [])
    .filter((row) => !ownedServices.includes(row.surface));
  if (unownedRows.length > 0) {
    throw new Error(`Registry '${surface.surface}' has rows outside its descriptor ownership: ${[...new Set(unownedRows.map(({ surface: owner }) => owner))].join(', ')}`);
  }
  const censusServices = [...new Set(descriptors.flatMap((descriptor) =>
    descriptor.kind === 'mirror' && descriptor.coverage ? [descriptor.censusSurface] : [],
  ))];
  const noCensusKind = censusServices.length > 0
    ? undefined
    : descriptors.every(({ kind }) => kind === 'integration') ? 'integration' : 'native';
  return { label: surface.label, censusServices, noCensusKind };
}

interface SurfaceScore {
  /** null when the page has no upstream Firebase public surface to measure. */
  runtime: { mapped: number; denominator: number; pct: number } | null;
  types: { mapped: number; denominator: number; pct: number } | null;
}

function computeSurface(spec: SurfaceScoreSpec, census: readonly SurfaceCensus[]): SurfaceScore {
  if (spec.censusServices.length === 0) return { runtime: null, types: null };
  const keys = new Set(spec.censusServices);
  const surfaces = census.filter(({ surface }) => keys.has(surface));
  if (surfaces.length === 0) return { runtime: null, types: null };
  const combine = (axis: 'runtime' | 'types') => {
    const mapped = surfaces.reduce((sum, surface) => sum + surface[axis].mapped.length, 0);
    const denominator = surfaces.reduce((sum, surface) => sum + surface[axis].upstreamCount, 0);
    return { mapped, denominator, pct: denominator === 0 ? 0 : Math.round((mapped / denominator) * 1000) / 10 };
  };
  return { runtime: combine('runtime'), types: combine('types') };
}

/** Public API breadth shown at the top of each compatibility document. */
export function scoreBlock(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): string | null {
  const spec = scoreSpec(surface, projection);
  const coverage = computeSurface(spec, projection.census);
  if (coverage.runtime === null || coverage.types === null) {
    const surfaceLine = spec.noCensusKind === 'integration'
      ? '<p class="compat-stat-surface"><strong>Surface:</strong> integration contract. This page does not have a Firebase public API denominator.</p>'
      : '<p class="compat-stat-surface"><strong>Surface:</strong> Pyric-owned API. This page does not mirror a Firebase public API denominator.</p>';
    return ['<div class="compat-stat">', surfaceLine, '</div>', ''].join('\n');
  }
  const scoreboardHref = relative(dirname(surface.compatPath), SCOREBOARD_PATH).replaceAll('\\', '/');
  return [
    '<div class="compat-stat">',
    '<p class="compat-stat-figure">',
    `<span class="compat-stat-pct">${coverage.runtime.pct}%</span>`,
    '<span class="compat-stat-label">of public runtime exports supported</span>',
    '</p>',
    `<p class="compat-stat-denom">${coverage.runtime.mapped} of ${coverage.runtime.denominator} public runtime exports <span aria-hidden="true">·</span> ${coverage.types.mapped} of ${coverage.types.denominator} public type exports</p>`,
    '</div>',
    `[See public API coverage for every service.](${scoreboardHref})`,
    '',
  ].join('\n');
}

function scoreRow(
  label: string,
  href: string | null,
  coverage: SurfaceScore,
  noCensusKind: SurfaceScoreSpec['noCensusKind'],
  overall = false,
): string[] {
  const noCensusLabel = noCensusKind === 'integration' ? 'integration' : 'native';
  const runtime = coverage.runtime === null
    ? noCensusLabel
    : `${coverage.runtime.pct}% (${coverage.runtime.mapped}/${coverage.runtime.denominator})`;
  const types = coverage.types === null
    ? noCensusLabel
    : `${coverage.types.pct}% (${coverage.types.mapped}/${coverage.types.denominator})`;
  const tag = href === null ? 'div' : 'a';
  const attrs = [
    `class="compat-score-row${overall ? ' compat-score-row--overall' : ''}"`,
    href === null ? '' : `href="${href}"`,
  ].filter(Boolean).join(' ');
  return [
    `<${tag} ${attrs}>`,
    `<span class="compat-score-name">${label}</span>`,
    '<span class="compat-score-surface">',
    `<span><span class="compat-score-axis">Runtime</span>${runtime}</span>`,
    `<span><span class="compat-score-axis">Types</span>${types}</span>`,
    '</span>',
    `</${tag}>`,
  ];
}

/** Central scoreboard across every scored COMPAT surface. */
export function renderScoreboardMarkdown(projection: DocumentationProjection): string {
  const lines: string[] = [
    GENERATED_HEADER,
    '',
    '# Public API coverage',
    '',
    'This is the share of Firebase\'s public API that Pyric supports. [How does Pyric know it works like Firebase?](../trust/how-we-know-it-matches-firebase/) explains the evidence and its limits.',
    '',
    '- **Public runtime surface:** mirrored Firebase runtime exports divided by all exports not exactly reviewed as private in the owning surface contract. Unsupported, deprecated, and deferred public APIs remain in the denominator.',
    '- **Public type surface:** mirrored exported type names divided by non-underscore Firebase exported type names. This measures name presence, not structural assignability.',
    '',
    '## Services',
    '',
    '<div class="compat-scoreboard">',
  ];
  for (const surface of projection.registries) {
    const spec = scoreSpec(surface, projection);
    const coverage = computeSurface(spec, projection.census);
    lines.push(...scoreRow(
      spec.label,
      compatibilityHref(surface.compatPath),
      coverage,
      spec.noCensusKind,
    ));
  }
  const coverageCensusSurfaces = projection.descriptors.flatMap((descriptor) =>
    descriptor.kind === 'mirror' && descriptor.coverage ? [descriptor.censusSurface] : [],
  );
  const overallCoverage = computeSurface({ label: 'Overall', censusServices: coverageCensusSurfaces }, projection.census);
  lines.push(...scoreRow(
    'Overall',
    null,
    overallCoverage,
    undefined,
    true,
  ));
  lines.push('</div>', '');
  return lines.join('\n');
}

function renderStatus(row: CompatibilityRow): string {
  const glyph = STATUS_GLYPHS[row.status];
  return row.statusNote ? `${glyph} ${row.statusNote}` : glyph;
}

function apiParts(row: CompatibilityRow): { name: string; category: string } {
  const raw = row.api.trim();
  if (raw === '' || raw.toLowerCase() === row.section.trim().toLowerCase()) {
    return { name: '', category: '' };
  }
  const at = raw.indexOf(' — ');
  if (at === -1) return { name: raw, category: '' };
  return { name: raw.slice(0, at).trim(), category: raw.slice(at + 3).trim() };
}

function renderRow(row: CompatibilityRow): string {
  const { name, category } = apiParts(row);
  return `| ${escapeCell(name)} | ${escapeCell(category)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(row.evidence)} | ${escapeCell(row.rowRef)} |`;
}

const GAP_SECTIONS: Array<{ status: Exclude<CompatStatus, 'conforms'>; title: string; intro: string }> = [
  {
    status: 'diverged-documented',
    title: 'Documented divergences',
    intro: 'Known differences between Pyric and production Firebase. Each remains tracked as a non-conforming row.',
  },
  {
    status: 'bug',
    title: 'Bugs',
    intro: 'Behavior that should match production Firebase but currently does not.',
  },
  {
    status: 'unsupported',
    title: 'Unsupported',
    intro: 'Tracked behavior that is not implemented in the current contract.',
  },
  {
    status: 'unverified',
    title: 'Unverified',
    intro: 'Tracked behavior whose available evidence does not yet establish the production result.',
  },
];

export function consolidatedGapSections(rows: CompatibilityRow[]): string {
  const sections = GAP_SECTIONS.flatMap(({ status, title, intro }) => {
    const matches = rows.filter((row) => row.status === status);
    if (matches.length === 0) return [];
    return [[
      `### ${title}`,
      '',
      intro,
      '',
      '| API | Behavior |',
      '|---|---|',
      ...matches.map((row) => `| ${escapeCell(apiParts(row).name)} | ${escapeCell(row.behavior)} |`),
      '',
    ].join('\n')];
  });
  if (sections.length === 0) return '';
  return ['## Current gaps', '', ...sections].join('\n').replace(/\s+$/, '');
}

/** Reviewed public-runtime gaps come from the same surface contracts consumed
 * by the census and query model. Registry prose must not duplicate them. */
export function dispositionSection(
  surface: CompatibilitySurfaceRegistry,
  projection: DocumentationProjection,
): string {
  const censusSurfaces = new Set(projection.descriptors.flatMap((descriptor) =>
    descriptor.registry === surface && descriptor.kind === 'mirror' && descriptor.coverage
      ? [descriptor.censusSurface]
      : [],
  ));
  const dispositions = projection.census
    .filter((entry) => censusSurfaces.has(entry.surface))
    .flatMap((entry) => entry.runtime.dispositioned);
  if (dispositions.length === 0) return '';
  const groups = Map.groupBy(dispositions, (entry) => entry.dispositionId);
  return [
    '## Reviewed public-runtime gaps',
    '',
    'These classifications are generated from the machine-readable surface contract used by the census and `can-i-use`.',
    '',
    '| Disposition | Availability | Symbols | Reason | Evidence |',
    '|---|---|---|---|---|',
    ...[...groups].map(([id, entries]) => {
      const first = entries[0]!;
      return `| ${escapeCell(id)} | ${first.availability} | ${escapeCell(entries.map(({ symbol }) => `\`${symbol}\``).join(', '))} | ${escapeCell(first.summary)} | ${escapeCell(first.evidenceRefs.join(', '))} |`;
    }),
  ].join('\n');
}

/** Non-conforming statuses, in the order the climb header lists them. */
const CLIMB_STATUS_ORDER: CompatStatus[] = ['unverified', 'diverged-documented', 'bug', 'unsupported'];

/**
 * The climb header for a surface admitted under CDD (cdd.md Step 7): rendered
 * above the status legend, derived from the registry's row statuses alone. A
 * non-climbing surface returns no lines, so its doc is byte-for-byte unchanged.
 * Kept identical between renderSurfaceMarkdown and generatedRowLineNumbers so
 * row line numbers stay accurate.
 */
export function climbHeaderLines(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): string[] {
  const climbing = projection.descriptors.some((d) => d.registry === surface && d.climb === true);
  if (!climbing) return [];
  const rows = surface.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
  const summary = (population: CompatibilityRow[], label?: string): string => {
    const conforming = population.filter((row) => row.status === 'conforms').length;
    const breakdown = CLIMB_STATUS_ORDER
      .map((status) => ({
        status,
        count: population.filter((row) => row.status === status).length,
      }))
      .filter((entry) => entry.count > 0)
      .map((entry) => `${entry.count} ${entry.status}`)
      .join(', ');
    return `> ${label ? `${label}: ` : ''}${conforming} of ${population.length} rows conforming.${breakdown ? ` ${breakdown}.` : ''}`;
  };
  const bySurface = Map.groupBy(rows, (row) => row.surface);
  const populationLines = bySurface.size === 1
    ? [summary(rows)]
    : [...bySurface].map(([rowSurface, population]) => summary(
        population,
        rowSurface === 'messaging'
          ? 'Client + service-worker mirror'
          : rowSurface === 'messaging-admin'
            ? 'Separately tracked Admin send plane'
            : rowSurface,
      ));
  return [
    '> **Climb status: this surface is climbing under CDD.**',
    ...populationLines,
    '> A `?` row below is a target with a derived failing test, not a guarantee.',
    '',
  ];
}

/** Inject the two-number score block under the H1 of the first markdown block. */
function scoredBlocks(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): CompatibilitySurfaceRegistry['blocks'] {
  const score = scoreBlock(surface, projection);
  if (score === null) return surface.blocks;
  return surface.blocks.map((block, index) => {
    if (index !== 0 || block.kind !== 'markdown') return block;
    // Insert after the first line (H1), before the rest of the intro.
    const lines = block.markdown.split('\n');
    const h1End = lines.findIndex((line, i) => i > 0 && line.trim() === '') ;
    const at = h1End === -1 ? 1 : h1End + 1;
    const next = [...lines.slice(0, at), score, ...lines.slice(at)].join('\n');
    return { ...block, markdown: next };
  });
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): string {
  const blocks = scoredBlocks(surface, projection);
  const parts: string[] = [GENERATED_HEADER, '', ...climbHeaderLines(surface, projection)];
  const rows = blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'markdown') {
      parts.push(block.markdown);
      continue;
    }
    parts.push(block.prefix);
    parts.push('| API | Category | Behavior | Status | Probe | # |');
    parts.push('|---|---|---|---|---|---|');
    for (const row of block.rows) parts.push(renderRow(row));
    const next = blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) parts.push('');
  }
  const gaps = consolidatedGapSections(rows);
  if (gaps) parts.push('', gaps);
  const dispositions = dispositionSection(surface, projection);
  if (dispositions) parts.push('', dispositions);
  return parts.join('\n').replace(/\s+$/, '') + '\n';
}

export function generatedRowLineNumbers(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): Map<string, number> {
  const blocks = scoredBlocks(surface, projection);
  const lines: string[] = [GENERATED_HEADER, '', ...climbHeaderLines(surface, projection)];
  const out = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'markdown') {
      const markdown = block.markdown;
      if (markdown) lines.push(...markdown.split('\n'));
      continue;
    }
    const prefix = block.prefix;
    if (prefix) lines.push(...prefix.split('\n'));
    lines.push('| API | Category | Behavior | Status | Probe | # |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of block.rows) {
      lines.push(renderRow(row));
      out.set(row.id, lines.length);
    }
    const next = blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) lines.push('');
  }
  const rows = blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
  const gaps = consolidatedGapSections(rows);
  if (gaps) lines.push('', ...gaps.split('\n'));
  const dispositions = dispositionSection(surface, projection);
  if (dispositions) lines.push('', ...dispositions.split('\n'));
  return out;
}

export function renderAllCompatibilityMarkdown(model: ConformanceModel): Map<string, string> {
  const projection = model.documentation;
  const out = new Map(projection.registries.map((surface) => [surface.compatPath, renderSurfaceMarkdown(surface, projection)]));
  out.set(SCOREBOARD_PATH, renderScoreboardMarkdown(projection));
  return out;
}

export interface CompatibilityPageCatalogEntry {
  path: string;
  label: string;
}

/** The complete generated-doc publication catalog. Presentation labels live
 * with their canonical registries; consumers iterate this instead of copying
 * a list of paths that can silently drift. */
export function compatibilityPageCatalog(model: ConformanceModel): readonly CompatibilityPageCatalogEntry[] {
  return [
    { path: SCOREBOARD_PATH, label: 'Public API coverage' },
    ...model.documentation.registries.map(({ compatPath, label }) => ({ path: compatPath, label })),
  ];
}

export function checkGeneratedMarkdown(model: ConformanceModel): string[] {
  const problems: string[] = [];
  for (const [rel, generated] of renderAllCompatibilityMarkdown(model)) {
    const path = join(REPO_ROOT, rel);
    let current: string;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      problems.push(`${rel}: missing (run bun run compat:generate --write)`);
      continue;
    }
    if (current !== generated) problems.push(`${rel}: does not match registry-generated output`);
  }
  return problems;
}

if (import.meta.main) {
  const model = await deriveConformanceModel();
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (write) {
    for (const [rel, generated] of renderAllCompatibilityMarkdown(model)) {
      const path = join(REPO_ROOT, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated);
    }
    console.log(`Generated ${model.documentation.registries.length} compatibility document(s) + scoreboard.`);
  }
  if (check) {
    const problems = checkGeneratedMarkdown(model);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      process.exit(1);
    }
    console.log('Compatibility markdown is generated from the conformance model.');
  }
}
