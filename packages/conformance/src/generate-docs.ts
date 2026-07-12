#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow, type CompatibilitySurfaceRegistry, type CompatStatus } from '../registry/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const GENERATED_HEADER = '<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->';

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

// ── Behavior conformance (the one number a reader needs) ────────────────────
//
// The per-surface COMPAT matrices carry row-by-row status. The single headline
// each doc leads with — and the central scoreboard — is behavior conformance:
// the share of a surface's evaluated rows whose recorded status is `conforms`.
// It is computed at generate time from the baseline ledger; `--check` re-reads
// the same artifact, so a doc that drifts from it fails the gate.

/** The generated central scoreboard, ported into the Compatibility nav group. */
export const SCOREBOARD_PATH = 'packages/pyric/docs/conformance/SCORES.md';

const COVERAGE_BASELINE_PATH = 'packages/conformance/baselines/coverage-baseline.json';

interface CoverageBaseline {
  rowStatuses: Record<string, string>;
}

function readArtifact<T>(rel: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as T;
}

/** One surface's mapping onto the behavior ledger. Keyed by the registry's `surface`. */
interface SurfaceScoreSpec {
  label: string;
  /** `rowStatuses` service prefixes whose behavior rows this surface owns. */
  rowServices: string[];
}

/**
 * The mapping from each generated COMPAT doc (keyed by its registry `surface`)
 * onto the ledger. The `rowStatuses` service keys do NOT line up 1:1 with the
 * surfaces: `rtdb` owns `rtdb` + `rtdb-modular`, `messaging` owns `messaging` +
 * `messaging-admin`, `rules` owns `firestore-rules` + `storage-rules` (its
 * `rtdb-rules` behavior rows are not yet in the baseline ledger).
 */
const SCORE_SPECS: Record<string, SurfaceScoreSpec> = {
  app: { label: 'App', rowServices: ['app'] },
  ai: { label: 'AI Logic', rowServices: ['ai'] },
  auth: { label: 'Auth', rowServices: ['auth'] },
  firestore: { label: 'Firestore', rowServices: ['firestore'] },
  rtdb: { label: 'Realtime Database', rowServices: ['rtdb', 'rtdb-modular'] },
  storage: { label: 'Storage', rowServices: ['storage'] },
  messaging: { label: 'Messaging', rowServices: ['messaging', 'messaging-admin'] },
  rules: { label: 'Rules', rowServices: ['firestore-rules', 'storage-rules'] },
};

interface BehaviorScore {
  conforms: number;
  total: number;
  pct: number;
}

/** The behavior conformance for a surface: conforming rows over evaluated rows. */
function computeBehavior(spec: SurfaceScoreSpec, base: CoverageBaseline): BehaviorScore {
  let conforms = 0;
  let total = 0;
  for (const [key, status] of Object.entries(base.rowStatuses)) {
    const svc = key.slice(0, key.indexOf('#'));
    if (!spec.rowServices.includes(svc)) continue;
    total += 1;
    if (status === 'conforms') conforms += 1;
  }
  const pct = total > 0 ? Math.round((conforms / total) * 100) : 0;
  return { conforms, total, pct };
}

/** The single behavior-conformance headline each surface doc leads with. */
export function behaviorHeadline(surface: CompatibilitySurfaceRegistry): string | null {
  const spec = SCORE_SPECS[surface.surface];
  if (!spec) return null;
  const { conforms, total, pct } = computeBehavior(spec, readArtifact(COVERAGE_BASELINE_PATH));
  return `**${conforms} of ${total} tracked behaviors match production Firebase (${pct}%).**`;
}

/** The one status legend every surface doc shares, generator-owned and identical across pages. */
const STATUS_LEGEND = [
  '## Status legend',
  '',
  '| Status | Meaning |',
  '|---|---|',
  '| ✓ | Matches Firebase |',
  '| ⚠ | Documented difference |',
  '| — | Not supported yet |',
  '| ? | Not verified yet |',
].join('\n');

function renderStatus(row: CompatibilityRow): string {
  const glyph = STATUS_GLYPHS[row.status];
  return row.statusNote ? `${glyph} ${row.statusNote}` : glyph;
}

function renderRow(row: CompatibilityRow): string {
  return `| ${escapeCell(row.rowRef)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(row.evidence)} |`;
}

/**
 * The surface's blocks with the behavior headline and shared status legend
 * injected under the H1 (the registry's first markdown block holds only the
 * H1). Both `renderSurfaceMarkdown` and `generatedRowLineNumbers` consume this
 * one block list, so they stay byte-for-byte in sync. A surface with no score
 * spec is unchanged.
 */
export function scoredBlocks(surface: CompatibilitySurfaceRegistry): CompatibilityDocBlock[] {
  const headline = behaviorHeadline(surface);
  if (headline === null) return surface.blocks;
  return surface.blocks.map((block, index) => {
    if (index === 0 && block.kind === 'markdown') {
      const h1 = block.markdown.trim();
      return { ...block, markdown: `${h1}\n\n${headline}\n\n${STATUS_LEGEND}\n` };
    }
    return block;
  });
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry): string {
  const parts: string[] = [GENERATED_HEADER, ''];
  const blocks = scoredBlocks(surface);
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'markdown') {
      parts.push(block.markdown);
      continue;
    }
    parts.push(block.prefix);
    parts.push('| # | Behavior | Status | Probe |');
    parts.push('|---|---|---|---|');
    for (const row of block.rows) parts.push(renderRow(row));
    const next = blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) parts.push('');
  }
  return parts.join('\n').replace(/\s+$/, '') + '\n';
}

export function generatedRowLineNumbers(surface: CompatibilitySurfaceRegistry): Map<string, number> {
  const lines: string[] = [GENERATED_HEADER, ''];
  const out = new Map<string, number>();
  const blocks = scoredBlocks(surface);
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'markdown') {
      const markdown = block.markdown;
      if (markdown) lines.push(...markdown.split('\n'));
      continue;
    }
    const prefix = block.prefix;
    if (prefix) lines.push(...prefix.split('\n'));
    lines.push('| # | Behavior | Status | Probe |');
    lines.push('|---|---|---|---|');
    for (const row of block.rows) {
      lines.push(renderRow(row));
      out.set(row.id, lines.length);
    }
    const next = blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) lines.push('');
  }
  return out;
}

/** Scoreboard row order: v1/conformance-held surfaces first, then the earlier ones. */
const SCOREBOARD_SURFACE_ORDER = ['firestore', 'auth', 'rtdb', 'storage', 'messaging', 'rules', 'ai', 'app'];

/**
 * The central scoreboard doc: one row per surface with its behavior-conformance
 * number, then one plain grouping sentence. Every number is read from the
 * baseline ledger at generate time, never asserted here.
 */
export function renderScoreboardMarkdown(): string {
  const base = readArtifact<CoverageBaseline>(COVERAGE_BASELINE_PATH);

  const lines: string[] = [
    GENERATED_HEADER,
    '',
    '# Conformance scores by surface',
    '',
    '| Service | Behaves like Firebase |',
    '|---|---|',
  ];

  for (const key of SCOREBOARD_SURFACE_ORDER) {
    const spec = SCORE_SPECS[key];
    if (!spec) continue;
    const { conforms, total, pct } = computeBehavior(spec, base);
    lines.push(`| ${escapeCell(spec.label)} | ${pct}% (${conforms} / ${total}) |`);
  }

  lines.push(
    '',
    'Auth, Firestore, and Rules are held to recorded production behavior. Realtime Database and Storage are earlier and pinned to fewer production observations.',
  );

  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

export function renderAllCompatibilityMarkdown(): Map<string, string> {
  const map = new Map(surfaceRegistries.map((surface) => [surface.compatPath, renderSurfaceMarkdown(surface)]));
  map.set(SCOREBOARD_PATH, renderScoreboardMarkdown());
  return map;
}

export function checkGeneratedMarkdown(): string[] {
  const problems: string[] = [];
  for (const [rel, generated] of renderAllCompatibilityMarkdown()) {
    const path = join(REPO_ROOT, rel);
    let current: string | null = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      problems.push(`${rel}: missing; run bun run compat:generate --write`);
      continue;
    }
    if (current !== generated) problems.push(`${rel}: does not match registry-generated output`);
  }
  return problems;
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (write) {
    const all = renderAllCompatibilityMarkdown();
    for (const [rel, generated] of all) {
      const path = join(REPO_ROOT, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated);
    }
    console.log(`Generated ${all.size} compatibility document(s) (incl. the scoreboard).`);
  }
  if (check) {
    const problems = checkGeneratedMarkdown();
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      process.exit(1);
    }
    console.log('Compatibility markdown is generated from the registry.');
  }
}
