#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CompatibilityRow, type CompatibilitySurfaceRegistry, type CompatStatus } from '../registry/index.ts';
import {
  deriveConformanceModel,
  type ConformanceModel,
} from './conformance-model.ts';
import type { SurfaceCensus } from './surface-census.ts';
import { compatibilityHref, compatibilitySlug } from './docs-routes.ts';

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
  const combined = combinedScore(coverage)!;
  return `${combined.mapped} of ${combined.denominator} public API`;
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

function meterCell(pct: number | string, basis: string): string {
  return '<div class="compat-score-stack">' +
    `<div class="compat-score-bar"><span class="compat-meter-track"><span class="compat-meter-fill" style="width: ${pct}%"></span></span>` +
    `<span class="compat-score-pct">${pct}%</span></div>` +
    (basis === '' ? '' : `<div class="compat-score-basis">${basis}</div>`) +
    '</div>';
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
  const score = combined !== null
    ? meterCell(combined.pct, splitLine(coverage))
    // No honest public-API denominator exists yet for this surface (#344).
    : surface !== null
      ? '<span class="compat-score-tbd">Gathering metrics. Total score TBD.</span>'
      : '';
  return [
    `<tr${overall ? ' class="compat-score-row--overall"' : ''}>`,
    `<th scope="row" class="compat-score-name">${name}</th>`,
    `<td class="compat-score-cell">${score}</td>`,
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
    'This is the share of Firebase\'s public API that Pyric supports. Not-implemented-yet, deprecated, and deferred APIs still count against the total. [How does Pyric know it works like Firebase?](../trust/how-we-know-it-matches-firebase/) explains the evidence and its limits.',
    '',
    '## Services',
    '',
    '<table class="compat-score-table">',
    '<thead><tr><th>Service</th><th>Public API supported</th></tr></thead>',
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

const testContentCache = new Map<string, string[]>();

/**
 * Retrieve and cache test file lines from disk to avoid redundant file I/O
 * during link validation and line discovery.
 */
function getTestLines(testPath: string): string[] | undefined {
  const cachedLines = testContentCache.get(testPath);
  if (cachedLines) return cachedLines;

  const absolutePath = join(REPO_ROOT, testPath);
  const fileExists = existsSync(absolutePath);
  if (!fileExists) return undefined;

  try {
    const rawContent = readFileSync(absolutePath, 'utf8');
    const fileLines = rawContent.split('\n');
    testContentCache.set(testPath, fileLines);
    return fileLines;
  } catch {
    return undefined;
  }
}

const IGNORED_API_WORDS = new Set(['and', 'with', 'the', 'for', 'from', 'returns', 'fails', 'when', 'true', 'false', 'that']);

/**
 * Extract meaningful code symbol names from authored markdown API descriptions.
 * Avoids complex or brittle regular expressions by splitting on non-alphanumeric boundaries
 * and excluding common grammatical English words and short punctuation tokens.
 */
function extractSymbolTokens(text: string): string[] {
  const identifierCandidates = text.split(/[^a-zA-Z0-9_-]+/);
  return identifierCandidates.filter((candidate) => {
    const isSufficientLength = candidate.trim().length > 3;
    const isDomainWord = !IGNORED_API_WORDS.has(candidate.toLowerCase());
    return isSufficientLength && isDomainWord;
  });
}

/**
 * Discover the precise line number in a test suite corresponding to a compatibility row.
 * Prioritizes exact metadata citations (observation IDs, row references) before falling back
 * to code symbol usage in test descriptions and assertions.
 */
export function findTestLineNumber(row: CompatibilityRow, testPath: string): number | null {
  const fileLines = getTestLines(testPath);
  if (!fileLines) return null;

  // Phase 1: Search for exact metadata matches (observation IDs, row identifiers, constructs)
  for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
    const lineContent = fileLines[lineIndex]!;
    const matchesObservation = row.oracleObservations.some((observationId) => lineContent.includes(observationId));
    const matchesRowId = lineContent.includes(row.id);
    const matchesRowAlias = row.aliases.some((rowAlias) => lineContent.includes(rowAlias));
    const matchesConstruct = Boolean(row.constructs?.some((constructId) => lineContent.includes(constructId)));

    const isExactMetadataMatch = matchesObservation || matchesRowId || matchesRowAlias || matchesConstruct;
    if (isExactMetadataMatch) {
      const oneIndexedLineNumber = lineIndex + 1;
      return oneIndexedLineNumber;
    }
  }

  // Phase 2: Search for explicit feature key symbol usages in code or test descriptions
  const featureKeys = row.featureKeys.filter((featureKey) => featureKey.trim().length > 2);
  if (featureKeys.length > 0) {
    for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
      const lineContent = fileLines[lineIndex]!;
      const matchesFeatureKey = featureKeys.some((featureKey) => lineContent.includes(featureKey));
      if (matchesFeatureKey) {
        const oneIndexedLineNumber = lineIndex + 1;
        return oneIndexedLineNumber;
      }
    }
  }

  // Phase 3: Search for primary API domain identifiers across the test file
  const symbolTokens = extractSymbolTokens(row.api);
  if (symbolTokens.length > 0) {
    for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
      const lineContent = fileLines[lineIndex]!;
      const matchesSymbol = symbolTokens.some((symbolToken) => lineContent.includes(symbolToken));
      if (matchesSymbol) {
        const oneIndexedLineNumber = lineIndex + 1;
        return oneIndexedLineNumber;
      }
    }
  }

  const defaultTopLineNumber = 1;
  return defaultTopLineNumber;
}

export function formatRowEvidence(
  row: CompatibilityRow,
  observationPaths?: Readonly<Record<string, string>>,
): string {
  const resolvedObservationPaths = observationPaths ?? {};
  let formattedEvidence = row.evidence;
  const unlinkedObservations = new Set(row.oracleObservations);
  const unlinkedTests = new Set(row.conformanceTests);

  formattedEvidence = formattedEvidence.replace(/`([^`]+)`/g, (originalMatch, token: string) => {
    for (const observationId of unlinkedObservations) {
      const isExactObservationMatch = token.includes(observationId);
      const tokenWithoutExtension = token.endsWith('.json') ? token.slice(0, -5) : token;
      const isSuffixMatch = tokenWithoutExtension.endsWith(observationId);
      const matchesObservationToken = isExactObservationMatch || isSuffixMatch;

      if (matchesObservationToken) {
        unlinkedObservations.delete(observationId);
        const relativePath = resolvedObservationPaths[observationId];
        const isPathValid = relativePath && existsSync(join(REPO_ROOT, relativePath));
        if (!isPathValid) {
          throw new Error(`Row ${row.id}: generated link targets untracked observation '${observationId}'`);
        }
        return `[${originalMatch}](https://github.com/davideast/pyric/blob/main/${relativePath})`;
      }
    }

    for (const testPath of unlinkedTests) {
      const colonIndex = token.indexOf(':');
      const hasNamespacePrefix = colonIndex !== -1;
      const targetFilename = hasNamespacePrefix ? token.slice(colonIndex + 1).trim() : token.trim();
      
      const testFileBasename = testPath.split('/').pop()!;
      const matchesFullPathSuffix = testPath.endsWith(targetFilename);
      const matchesBasenameSuffix = targetFilename.endsWith(testFileBasename);
      const matchesTestFileToken = matchesFullPathSuffix || matchesBasenameSuffix;

      if (matchesTestFileToken) {
        unlinkedTests.delete(testPath);
        const absolutePath = join(REPO_ROOT, testPath);
        const fileExists = existsSync(absolutePath);
        if (!fileExists) {
          throw new Error(`Row ${row.id}: generated link targets untracked test file '${testPath}'`);
        }
        const targetLineNumber = findTestLineNumber(row, testPath);
        const lineHashSuffix = targetLineNumber !== null ? `#L${targetLineNumber}` : '';
        return `[${originalMatch}](https://github.com/davideast/pyric/blob/main/${testPath}${lineHashSuffix})`;
      }
    }

    return originalMatch;
  });

  const trailingLinks: string[] = [];
  for (const observationId of unlinkedObservations) {
    const relativePath = resolvedObservationPaths[observationId];
    const isPathValid = relativePath && existsSync(join(REPO_ROOT, relativePath));
    if (!isPathValid) {
      throw new Error(`Row ${row.id}: generated link targets untracked observation '${observationId}'`);
    }
    trailingLinks.push(`[\`${observationId}\`](https://github.com/davideast/pyric/blob/main/${relativePath})`);
  }

  for (const testPath of unlinkedTests) {
    const absolutePath = join(REPO_ROOT, testPath);
    const fileExists = existsSync(absolutePath);
    if (!fileExists) {
      throw new Error(`Row ${row.id}: generated link targets untracked test file '${testPath}'`);
    }
    const targetLineNumber = findTestLineNumber(row, testPath);
    const lineHashSuffix = targetLineNumber !== null ? `#L${targetLineNumber}` : '';
    const testFileBasename = testPath.split('/').pop()!;
    trailingLinks.push(`[\`${testFileBasename}\`](https://github.com/davideast/pyric/blob/main/${testPath}${lineHashSuffix})`);
  }

  const hasTrailingLinks = trailingLinks.length > 0;
  if (hasTrailingLinks) {
    formattedEvidence += ` (Structured evidence: ${trailingLinks.join(', ')})`;
  }

  return formattedEvidence;
}

function renderRow(row: CompatibilityRow, observationPaths?: Readonly<Record<string, string>>): string {
  const { name, category } = apiParts(row);
  return `| ${escapeCell(name)} | ${escapeCell(category)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(formatRowEvidence(row, observationPaths))} | ${escapeCell(row.rowRef)} |`;
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

const GAP_STATUS_KEYS: Record<string, { key: string; label: string }> = {
  'diverged-documented': { key: 'diverged', label: 'Diverged (documented)' },
  bug: { key: 'bug', label: 'Bug' },
  unsupported: { key: 'unsupported', label: 'Not implemented yet' },
  unverified: { key: 'unverified', label: 'Unverified' },
};

export function renderInlineEvidenceHtml(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function consolidatedGapSections(rows: CompatibilityRow[], observationPaths?: Readonly<Record<string, string>>): string {
  const sections = GAP_SECTIONS.flatMap(({ status, title, intro }) => {
    const matches = rows.filter((row) => row.status === status);
    if (matches.length === 0) return [];
    const meta = GAP_STATUS_KEYS[status]!;
    // Same row component as the entry tables: status dot, api name,
    // behavior sub-line, evidence behind the disclosure.
    const items = matches.map((row) => {
      const { name } = apiParts(row);
      const dot = `<span class="compat-dot" data-status="${meta.key}" role="img" aria-label="${meta.label}" title="${meta.label}"></span>`;
      const main = '<span class="compat-main">' +
        (name === '' ? '' : `<code class="compat-api">${escapeHtml(name)}</code>`) +
        `<span class="compat-sub"><span class="compat-behavior">${escapeHtml(row.behavior).replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>')}</span></span></span>`;
      const evidenceStr = row.evidence.trim() === '' ? '' : formatRowEvidence(row, observationPaths);
      const evidence = evidenceStr === ''
        ? ''
        : `<div class="compat-evidence"><div class="compat-note">${renderInlineEvidenceHtml(evidenceStr)}</div></div>`;
      return evidence === ''
        ? `<div class="compat-row" data-status="${meta.key}"><div class="compat-line">${dot}${main}</div></div>`
        : `<details class="compat-row" data-status="${meta.key}"><summary class="compat-line">${dot}${main}</summary>\n${evidence}</details>`;
    });
    return [[
      `### ${title}`,
      '',
      intro,
      '',
      '<div class="compat-list">',
      ...items,
      '</div>',
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
  const availabilityLabel = (availability: string): string =>
    availability === 'deferred' ? 'Not implemented yet' : 'Out of scope';
  // The same row component the entry tables render (via compat-tables.ts):
  // status dot, a code identifier, a behavior sub-line, and an expandable
  // evidence body. Gaps are ordinary rows with a not-available status.
  const rows = [...groups].map(([id, entries]) => {
    const first = entries[0]!;
    const label = availabilityLabel(first.availability);
    const summary = escapeHtml(first.summary).replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>');
    const symbols = entries.map(({ symbol }) => `<code>${escapeHtml(symbol)}</code>`).join(' ');
    const notes = [
      `<div class="compat-note">${symbols}</div>`,
      first.evidenceRefs.length > 0 ? `<div class="compat-note">${escapeHtml(first.evidenceRefs.join(', '))}</div>` : '',
    ].filter(Boolean).join('\n');
    const dot = `<span class="compat-dot" data-status="unsupported" role="img" aria-label="${label}" title="${label}"></span>`;
    const main = `<span class="compat-main"><code class="compat-api">${escapeHtml(id)}</code>` +
      `<span class="compat-sub"><span class="compat-behavior">${summary}</span></span></span>`;
    return [
      '<details class="compat-row" data-status="unsupported">',
      `<summary class="compat-line">${dot}${main}</summary>`,
      `<div class="compat-evidence">${notes}</div>`,
      '</details>',
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

/** The reader-facing subset of a registry. Internal and historical entries
 * remain in the canonical ledger but do not become public compatibility
 * claims, gap entries, or documentation links. */
function publishedBlocks(surface: CompatibilitySurfaceRegistry): CompatibilitySurfaceRegistry['blocks'] {
  const blocks: CompatibilitySurfaceRegistry['blocks'] = [];
  for (const block of surface.blocks) {
    if (block.kind === 'markdown') {
      blocks.push(block);
      continue;
    }
    if (block.publishInCompatibilityDocs === false) continue;
    const rows = block.rows.filter((row) => row.publishInCompatibilityDocs !== false);
    if (rows.length > 0) blocks.push({ ...block, rows });
  }
  return blocks;
}

/** All of a surface's published blocks with presentation derived from its own rows:
 * the score block (coverage figure + to-scale meters) lands under the first
 * heading, and every status legend keys only the statuses this surface
 * actually uses. */
function scoredBlocks(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection) {
  const blocks = publishedBlocks(surface);
  const present: ReadonlySet<CompatStatus> = new Set(
    blocks.flatMap((block) => (block.kind === 'table' ? block.rows.map((row) => row.status) : [])),
  );
  const score = scoreBlock(surface, projection);
  let scorePlaced = score === null;
  return blocks.map((block) => {
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

/** The single source of truth for a surface's rendered projection: the exact
 * sequence of output lines, plus the 1-based line number each registry row
 * lands on. Both the published markdown and the line-number index derive from
 * this one pass, so a renderer change (a heading, a legend row, whitespace)
 * can never shift the line numbers the ledger points at without moving the
 * rendered rows in lockstep — there is no parallel render to drift out of sync
 * with. The row identity keyed here is `row.id` (a stable surface + entry-slug
 * string, e.g. `auth#31`); line numbers are a derived read-time coordinate. */
function renderSurfaceLines(
  surface: CompatibilitySurfaceRegistry,
  projection: DocumentationProjection,
): { lines: string[]; rowLines: Map<string, number> } {
  const blocks = scoredBlocks(surface, projection);
  // The CDD climb header is intentionally not published on the reader-facing
  // pages (insider methodology). Climb data still drives internal reports and
  // gates via climb.ts; only the published line is dropped.
  const lines: string[] = [];
  const rowLines = new Map<string, number>();
  // Append a part exactly as the published markdown would (parts joined with
  // '\n'), while keeping each output line addressable for the row index. Split
  // then join is an identity, so `lines.join('\n')` equals the flat-part join.
  const emit = (part: string) => { for (const line of part.split('\n')) lines.push(line); };
  emit(GENERATED_HEADER);
  emit('');
  const rows = blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'markdown') {
      emit(block.markdown);
      continue;
    }
    emit(block.prefix);
    emit('| API | Category | Behavior | Status | Probe | # |');
    emit('|---|---|---|---|---|---|');
    for (const row of block.rows) {
      emit(renderRow(row, projection.observationPaths));
      rowLines.set(row.id, lines.length);
    }
    const next = blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) emit('');
  }
  const gaps = consolidatedGapSections(rows, projection.observationPaths);
  if (gaps) { emit(''); emit(gaps); }
  const dispositions = dispositionSection(surface, projection);
  if (dispositions) { emit(''); emit(dispositions); }
  return { lines, rowLines };
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): string {
  return renderSurfaceLines(surface, projection).lines.join('\n').replace(/\s+$/, '') + '\n';
}

/** The 1-based line number, in the rendered surface page, of each registry
 * row's table entry — keyed by the stable `row.id`. Derived from the same pass
 * as {@link renderSurfaceMarkdown} so the coordinates can never desynchronize
 * from the projection they describe. */
export function generatedRowLineNumbers(surface: CompatibilitySurfaceRegistry, projection: DocumentationProjection): Map<string, number> {
  return renderSurfaceLines(surface, projection).rowLines;
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

/** Bake the rendered conformance pages into a typed data module — the docs
 * projection consumed by the site (and any other tool) through the published
 * `@pyric/cli/conformance/docs` subpath. Rendering happens here, once, at
 * package build; consumers display, they never re-derive. */
export function renderDocsProjectionModule(model: ConformanceModel): string {
  const catalog = compatibilityPageCatalog(model);
  const rendered = renderAllCompatibilityMarkdown(model);
  const pages = catalog.map(({ path, label }) => {
    const markdown = rendered.get(path);
    if (markdown === undefined) throw new Error(`docs projection: renderer produced no page for ${path}`);
    const slug = path === SCOREBOARD_PATH ? 'conformance-scores' : compatibilitySlug(path);
    const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, '') ?? label;
    return { slug, label, title, markdown };
  });
  return [
    '// GENERATED FILE. Do not edit or commit.',
    '// Regenerate: bun run compat:conformance',
    '// Source: the central conformance model; pages are rendered projections.',
    'export interface ConformanceDocsPage {',
    '  /** Public docs route slug under /docs/. */',
    '  slug: string;',
    '  /** Short catalog label (nav / listings). */',
    '  label: string;',
    '  /** The page h1, plain text. */',
    '  title: string;',
    '  /** Full page markdown, ready to render. */',
    '  markdown: string;',
    '}',
    `export const CONFORMANCE_DOCS_PAGES: readonly ConformanceDocsPage[] = ${JSON.stringify(pages)};`,
    '',
  ].join('\n');
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
