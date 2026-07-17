#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** HTML-escape text emitted directly into a raw-HTML block. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

/** Combined public-API score: runtime and type exports pooled into one
 * fraction, the single number shown to readers. */
interface CombinedScore { mapped: number; denominator: number; pct: number }

function combinedScore(coverage: SurfaceScore): CombinedScore | null {
  if (coverage.runtime === null || coverage.types === null) return null;
  const mapped = coverage.runtime.mapped + coverage.types.mapped;
  const denominator = coverage.runtime.denominator + coverage.types.denominator;
  return { mapped, denominator, pct: denominator === 0 ? 0 : Math.round((mapped / denominator) * 1000) / 10 };
}

/** The runtime · types split, shown as one small-print line under the bar. */
function splitLine(coverage: SurfaceScore): string {
  const runtime = coverage.runtime!;
  const types = coverage.types!;
  return `${runtime.mapped} of ${runtime.denominator} runtime exports <span aria-hidden="true">·</span> ${types.mapped} of ${types.denominator} type exports`;
}

/** One to-scale combined public-surface bar. Plain HTML/CSS, no script. */
function surfaceMeter(pct: number): string {
  return [
    '<div class="compat-meters">',
    `<span class="compat-meter-track"><span class="compat-meter-fill" style="width: ${pct}%"></span></span>`,
    '</div>',
  ].join('\n');
}

/** Public API breadth shown at the top of each compatibility document. */
export function scoreBlock(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): string | null {
  const spec = scoreSpec(surface, projection);
  const coverage = computeSurface(spec, projection.census);
  const combined = combinedScore(coverage);
  if (combined === null) {
    const surfaceLine = spec.noCensusKind === 'integration'
      ? '<p class="compat-stat-surface">This page tracks an integration contract: unchanged Firebase code run through a Pyric runtime seam, so there is no separate Firebase public API to measure. The rows below are its signed behavior inventory.</p>'
      : '<p class="compat-stat-surface">This is a Pyric-native API with no Firebase counterpart, so coverage is measured against its own public exports rather than a Firebase surface.</p>';
    return ['<div class="compat-stat">', surfaceLine, '</div>', ''].join('\n');
  }
  return [
    '<div class="compat-stat">',
    '<p class="compat-stat-figure">',
    `<span class="compat-stat-pct">${combined.pct}%</span>`,
    '<span class="compat-stat-label">of the public API supported</span>',
    '</p>',
    surfaceMeter(combined.pct),
    `<p class="compat-stat-denom">${splitLine(coverage)}</p>`,
    '</div>',
    '',
  ].join('\n');
}

function meterCell(pct: number | string): string {
  return `<span class="compat-score-pct">${pct}%</span>` +
    `<span class="compat-meter-track compat-meter-track--mini"><span class="compat-meter-fill" style="width: ${pct}%"></span></span>`;
}

function scoreRow(
  label: string,
  href: string | null,
  surface: CompatibilitySurfaceRegistry | null,
  coverage: SurfaceScore,
  overall = false,
): string[] {
  const combined = combinedScore(coverage);
  const name = href === null ? escapeCell(label) : `<a href="${href}">${escapeCell(label)}</a>`;
  let score: string;
  let detail: string;
  if (combined !== null) {
    score = meterCell(combined.pct);
    detail = splitLine(coverage);
  } else if (surface !== null) {
    // No honest public-API denominator exists yet for this surface (#343).
    score = '<span class="compat-score-tbd">Gathering metrics. Total score TBD.</span>';
    detail = '';
  } else {
    score = '';
    detail = '';
  }
  return [
    `<tr${overall ? ' class="compat-score-row--overall"' : ''}>`,
    `<th scope="row" class="compat-score-name">${name}</th>`,
    `<td class="compat-score-cell">${score}</td>`,
    `<td class="compat-score-detail">${detail}</td>`,
    '</tr>',
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
    '- **Public runtime surface:** the share of Firebase\'s public runtime exports that Pyric provides. Not-implemented-yet, deprecated, and deferred public APIs still count against the total.',
    '- **Public type surface:** the share of Firebase\'s public exported type names that Pyric provides. This measures name presence, not structural assignability.',
    '',
    '## Services',
    '',
    '<table class="compat-score-table">',
    '<thead><tr><th>Service</th><th>Score</th><th>Basis</th></tr></thead>',
    '<tbody>',
  ];
  for (const surface of projection.registries) {
    const spec = scoreSpec(surface, projection);
    const coverage = computeSurface(spec, projection.census);
    lines.push(...scoreRow(
      spec.label,
      compatibilityHref(surface.compatPath),
      surface,
      coverage,
    ));
  }
  const coverageCensusSurfaces = projection.descriptors.flatMap((descriptor) =>
    descriptor.kind === 'mirror' && descriptor.coverage ? [descriptor.censusSurface] : [],
  );
  const overallCoverage = computeSurface({ label: 'Overall', censusServices: coverageCensusSurfaces }, projection.census);
  lines.push(...scoreRow(
    'Overall',
    null,
    null,
    overallCoverage,
    true,
  ));
  lines.push('</tbody>', '</table>', '');
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
    title: 'Not implemented yet',
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
  const rows = [...groups].map(([id, entries]) => {
    const first = entries[0]!;
    const symbols = entries.map(({ symbol }) => `<code>${escapeHtml(symbol)}</code>`).join(', ');
    const evidence = first.evidenceRefs.length > 0
      ? `<div class="compat-note">${escapeHtml(first.evidenceRefs.join(', '))}</div>`
      : '';
    return [
      '<div class="compat-row" data-status="unsupported">',
      '<div class="compat-line"><span class="compat-main">' +
        `<code class="compat-api">${escapeHtml(id)}</code>` +
        `<span class="compat-sub"><span class="compat-behavior">${escapeHtml(first.availability)}</span></span></span></div>`,
      '<div class="compat-evidence">' +
        `<div class="compat-note">${escapeHtml(first.summary).replace(/`([^`]+)`/g, '<code>$1</code>')} — ${symbols}</div>` +
        evidence +
        '</div>',
      '</div>',
    ].join('\n');
  });
  return [
    '## Reviewed public-runtime gaps',
    '',
    '<div class="compat-list">',
    ...rows,
    '</div>',
  ].join('\n');
}



/** Canonical status order for a rendered legend, independent of which subset
 * of statuses a surface currently uses. */
const LEGEND_STATUS_ORDER = ['conforms', 'diverged-documented', 'bug', 'unsupported', 'unverified'] as const;

const LEGEND_GLYPHS: Record<CompatStatus, string> = {
  conforms: '\u2713',
  'diverged-documented': '\u26a0',
  bug: '\u2717',
  unsupported: '\u2014',
  unverified: '?',
};

/**
 * Rewrite a "## Status legend" table so it keys only the statuses that actually
 * occur in this surface's rows, in canonical order. A legend is a key to the
 * page it sits on: a status that never appears in the rows below is not part
 * of the key, and reappears automatically the moment a row carries it.
 */
function rewriteLegend(markdown: string, present: ReadonlySet<CompatStatus>): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inLegend = false;
  for (const line of lines) {
    if (/^##\s+Status legend/.test(line)) {
      inLegend = true;
      out.push(line);
      continue;
    }
    if (inLegend) {
      const isHeader = /^\|\s*Status\s*\|/.test(line) || /^\|[\s:|-]+\|?\s*$/.test(line);
      const cell = line.match(/^\|\s*(\S+)\s*\|/);
      if (cell && !isHeader) {
        const glyph = cell[1];
        const status = LEGEND_STATUS_ORDER.find((candidate) => LEGEND_GLYPHS[candidate] === glyph);
        if (status !== undefined && !present.has(status)) continue;
        out.push(line);
        continue;
      }
      if (!line.startsWith('|') && line.trim() !== '') inLegend = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** All of a surface's blocks with presentation derived from its own rows:
 * the score block (coverage figure + to-scale meters) lands under the first
 * heading, and every status legend keys only the statuses this surface
 * actually uses. */
function scoredBlocks(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection) {
  const present: ReadonlySet<CompatStatus> = new Set(
    surface.blocks.flatMap((block) => (block.kind === 'table' ? block.rows.map((row) => row.status) : [])),
  );
  const score = scoreBlock(surface, projection);
  let scorePlaced = score === null;
  return surface.blocks.map((block) => {
    if (block.kind !== 'markdown') return block;
    let markdown = rewriteLegend(block.markdown, present);
    if (!scorePlaced) {
      const lines = markdown.split('\n');
      const h1 = lines.findIndex((line) => line.startsWith('# '));
      if (h1 !== -1) {
        lines.splice(h1 + 1, 0, '', score!);
        markdown = lines.join('\n');
        scorePlaced = true;
      }
    }
    return { ...block, markdown };
  });
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): string {
  const blocks = scoredBlocks(surface, projection);
  // The CDD climb header is intentionally not published on the reader-facing
  // pages (insider methodology). Climb data still drives internal reports and
  // gates via climb.ts; only the published line is dropped.
  const parts: string[] = [GENERATED_HEADER, ''];
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
  const lines: string[] = [GENERATED_HEADER, ''];
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
