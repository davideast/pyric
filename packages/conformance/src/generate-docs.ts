#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow, type CompatibilitySurfaceRegistry, type CompatStatus } from '../registry/index.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const GENERATED_HEADER = '<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->';

/** The generated central scoreboard, ported into the Compatibility nav group. */
export const SCOREBOARD_PATH = 'packages/pyric/docs/conformance/SCORES.md';

const COVERAGE_BASELINE_PATH = 'packages/conformance/baselines/coverage-baseline.json';

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

// ── Scoring (surface coverage + fidelity) ───────────────────────────────────
//
// Kept as distinct numbers (#224). Do NOT fold coverage into fidelity.
// Both are read from the committed coverage baseline so `--check` fails when
// a doc drifts from the ledger.

interface CoverageBaseline {
  services: Record<string, {
    surfaceCoveragePct?: { total: number; intended: number };
    native?: boolean;
  }>;
  overall: { surfaceCoveragePct: { total: number; intended: number } };
  rowStatuses: Record<string, string>;
}

function readBaseline(): CoverageBaseline {
  return JSON.parse(readFileSync(join(REPO_ROOT, COVERAGE_BASELINE_PATH), 'utf8')) as CoverageBaseline;
}

/** One surface's mapping onto the behavior ledger + surface census. */
interface SurfaceScoreSpec {
  label: string;
  /** `rowStatuses` service prefixes whose behavior rows this surface owns. */
  rowServices: string[];
  /** Baseline `services` keys that contribute surface-coverage % (mirror only). */
  censusServices: string[];
}

/**
 * Registry `surface` → score axes. `rtdb` owns classic + modular behavior rows;
 * surface coverage comes from the modular census (classic `rtdb` is native).
 * `rules` owns firestore-rules + storage-rules behavior; rtdb-rules rows live
 * in the baseline under their own key when present.
 */
const SCORE_SPECS: Record<string, SurfaceScoreSpec> = {
  app: { label: 'App', rowServices: ['app'], censusServices: ['app'] },
  ai: { label: 'AI Logic', rowServices: ['ai'], censusServices: ['ai'] },
  auth: { label: 'Auth', rowServices: ['auth'], censusServices: ['auth'] },
  firestore: { label: 'Firestore', rowServices: ['firestore'], censusServices: ['firestore'] },
  rtdb: { label: 'Realtime Database', rowServices: ['rtdb', 'rtdb-modular'], censusServices: ['rtdb-modular'] },
  storage: { label: 'Storage', rowServices: ['storage'], censusServices: ['storage'] },
  messaging: { label: 'Messaging', rowServices: ['messaging', 'messaging-admin'], censusServices: ['messaging'] },
  rules: { label: 'Rules', rowServices: ['firestore-rules', 'storage-rules', 'rtdb-rules'], censusServices: [] },
};

interface BehaviorScore {
  conforms: number;
  total: number;
  pct: number;
}

interface SurfaceScore {
  /** null when the page has no upstream Firebase public surface to measure. */
  intendedPct: number | null;
  totalPct: number | null;
}

function computeBehavior(spec: SurfaceScoreSpec, base: CoverageBaseline): BehaviorScore {
  let conforms = 0;
  let total = 0;
  for (const [key, status] of Object.entries(base.rowStatuses)) {
    const svc = key.slice(0, key.indexOf('#'));
    if (!spec.rowServices.includes(svc)) continue;
    total += 1;
    if (status === 'conforms') conforms += 1;
  }
  const pct = total > 0 ? Math.round((conforms / total) * 1000) / 10 : 0;
  return { conforms, total, pct };
}

function computeSurface(spec: SurfaceScoreSpec, base: CoverageBaseline): SurfaceScore {
  if (spec.censusServices.length === 0) return { intendedPct: null, totalPct: null };
  // Today every scored page maps to at most one census service; if that ever
  // changes, average the stored percentages equally.
  const pcts: { total: number; intended: number }[] = [];
  for (const key of spec.censusServices) {
    const svc = base.services[key];
    if (!svc?.surfaceCoveragePct) continue;
    pcts.push(svc.surfaceCoveragePct);
  }
  if (pcts.length === 0) return { intendedPct: null, totalPct: null };
  if (pcts.length === 1) return { intendedPct: pcts[0].intended, totalPct: pcts[0].total };
  const totalPct = Math.round((pcts.reduce((s, p) => s + p.total, 0) / pcts.length) * 10) / 10;
  const intendedPct = Math.round((pcts.reduce((s, p) => s + p.intended, 0) / pcts.length) * 10) / 10;
  return { intendedPct, totalPct };
}

/**
 * Score block each COMPAT doc leads with: surface coverage (breadth) and
 * fidelity (tracked claims that match production). Separate on purpose.
 */
export function scoreBlock(surface: CompatibilitySurfaceRegistry, base = readBaseline()): string | null {
  const spec = SCORE_SPECS[surface.surface];
  if (!spec) return null;
  const behavior = computeBehavior(spec, base);
  const coverage = computeSurface(spec, base);
  const fidelityLine = `**Fidelity:** ${behavior.pct}% (${behavior.conforms} of ${behavior.total} tracked claims match production)`;
  const coverageLine = coverage.intendedPct === null
    ? '**Surface coverage:** native (no upstream Firebase public API — measured against pyric\'s own surface)'
    : `**Surface coverage:** ${coverage.totalPct}% of Firebase's public exports · ${coverage.intendedPct}% of what pyric intends to mirror`;
  return [
    '> ' + coverageLine,
    '>',
    '> ' + fidelityLine,
    '>',
    '> Coverage is about whether the export exists. Fidelity is about whether each claimed interaction matches production Firebase — see the [scoreboard](../conformance/SCORES.md) for what that percentage does and does not mean.',
    '',
  ].join('\n');
}

/** Central scoreboard across every scored COMPAT surface. */
export function renderScoreboardMarkdown(base = readBaseline()): string {
  const lines: string[] = [
    GENERATED_HEADER,
    '',
    '# Conformance scores',
    '',
    'Pyric claims to mirror Firebase\'s observable behavior so you can develop against a sandbox and trust the swap. Conformance is the open receipt for that claim — not a parity badge. Three numbers answer three different questions. Do not fold them together.',
    '',
    '## Surface coverage (total)',
    '',
    '**Question:** How much of this Firebase package is here at all?',
    '',
    'Numerator: runtime exports pyric re-exports. Denominator: every public runtime export of the upstream package (e.g. `firebase/auth`), including APIs pyric has written off and ones not built yet. If a call exists in the Firebase docs, this number says whether pyric even has a symbol for it.',
    '',
    '## Surface coverage (intended)',
    '',
    '**Question:** Against the contract pyric claims, how complete is the mirror?',
    '',
    'Same numerator. Denominator drops only genuine `out-of-scope` symbols (Firebase-internal `_` plumbing, APIs pyric will not model). Deferred work — intended, not yet built — stays in the denominator as a gap, so planned-but-missing still lowers this number. Always ≥ total. This is the headline breadth number.',
    '',
    '## Fidelity',
    '',
    '**Question:** Of the claims pyric tracks in the compatibility matrix, how many match production Firebase?',
    '',
    'This is the fidelity number, and it is the easiest to misread.',
    '',
    'It is **not** "percent of Firebase that works." It is **not** surface coverage restated. It only scores rows that already appear in the per-service COMPAT matrix — discrete, named claims such as "sign-in with a wrong password throws `auth/wrong-password`" or "`getDocs` returns documents the signed-in user can read." Each row has a status:',
    '',
    '| Status | Glyph | Counts as | Meaning |',
    '|---|---|---|---|',
    '| Conforms | ✓ | match | Sandbox matches production; locked by a probe or oracle observation |',
    '| Diverged (documented) | ⚠ | miss | Intentional, written difference from production |',
    '| Bug | ✗ | miss | Should match production and does not |',
    '| Unsupported | — | miss | Tracked but not implemented yet |',
    '| Unverified | ? | miss | Claimed, not yet checked against production |',
    '',
    '**Numerator:** rows with status `conforms`. **Denominator:** every tracked row for that surface. Documented divergences, bugs, unsupported gaps, and unverified claims all lower the percentage — none are relabeled as success.',
    '',
    'What a high or low number means:',
    '',
    '- **High fidelity, low surface coverage** — a small slice is mirrored, and that slice mostly matches production. Breadth is the remaining risk.',
    '- **High surface coverage, low fidelity** — many exports exist, but the matrix still carries divergences, unverified rows, or unfinished claims. Presence is not fidelity.',
    '- **Fidelity never credits missing exports** — an API that is not in the matrix does not help or hurt this number. That gap belongs to surface coverage.',
    '',
    'Read the matrix below the score on each COMPAT page for the concrete rows behind the percentage.',
    '',
    '## Scores',
    '',
    '| Surface | Surface coverage (total) | Surface coverage (intended) | Fidelity |',
    '|---|---|---|---|',
  ];
  for (const surface of surfaceRegistries) {
    const spec = SCORE_SPECS[surface.surface];
    if (!spec) continue;
    const behavior = computeBehavior(spec, base);
    const coverage = computeSurface(spec, base);
    const totalCell = coverage.totalPct === null ? 'native' : `${coverage.totalPct}%`;
    const intendedCell = coverage.intendedPct === null ? 'native' : `${coverage.intendedPct}%`;
    lines.push(`| ${spec.label} | ${totalCell} | ${intendedCell} | ${behavior.pct}% (${behavior.conforms}/${behavior.total}) |`);
  }
  const overallBehavior = (() => {
    let conforms = 0;
    let total = 0;
    const scored = new Set(Object.values(SCORE_SPECS).flatMap((s) => s.rowServices));
    for (const [key, status] of Object.entries(base.rowStatuses)) {
      const svc = key.slice(0, key.indexOf('#'));
      if (!scored.has(svc)) continue;
      total += 1;
      if (status === 'conforms') conforms += 1;
    }
    return { conforms, total, pct: total > 0 ? Math.round((conforms / total) * 1000) / 10 : 0 };
  })();
  lines.push(`| **Overall** | **${base.overall.surfaceCoveragePct.total}%** | **${base.overall.surfaceCoveragePct.intended}%** | **${overallBehavior.pct}%** (${overallBehavior.conforms}/${overallBehavior.total}) |`);
  lines.push('');
  return lines.join('\n');
}

function renderStatus(row: CompatibilityRow): string {
  const glyph = STATUS_GLYPHS[row.status];
  return row.statusNote ? `${glyph} ${row.statusNote}` : glyph;
}

function renderRow(row: CompatibilityRow): string {
  return `| ${escapeCell(row.rowRef)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(row.evidence)} |`;
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
export function climbHeaderLines(surface: CompatibilitySurfaceRegistry): string[] {
  const climbing = surfaceDescriptors.some((d) => d.registry === surface && d.climb === true);
  if (!climbing) return [];
  const rows = surface.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
  const conforming = rows.filter((row) => row.status === 'conforms').length;
  const breakdown = CLIMB_STATUS_ORDER.map((status) => ({ status, count: rows.filter((row) => row.status === status).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status}`)
    .join(', ');
  return [
    '> **Climb status: this surface is climbing under CDD.**',
    `> ${conforming} of ${rows.length} rows conforming.${breakdown ? ` ${breakdown}.` : ''}`,
    '> A `?` row below is a target with a derived failing test, not a guarantee.',
    '',
  ];
}

/** Inject the two-number score block under the H1 of the first markdown block. */
function scoredBlocks(surface: CompatibilitySurfaceRegistry): CompatibilitySurfaceRegistry['blocks'] {
  const score = scoreBlock(surface);
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

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry): string {
  const blocks = scoredBlocks(surface);
  const parts: string[] = [GENERATED_HEADER, '', ...climbHeaderLines(surface)];
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
  const blocks = scoredBlocks(surface);
  const lines: string[] = [GENERATED_HEADER, '', ...climbHeaderLines(surface)];
  const out = new Map<string, number>();
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

export function renderAllCompatibilityMarkdown(): Map<string, string> {
  const out = new Map(surfaceRegistries.map((surface) => [surface.compatPath, renderSurfaceMarkdown(surface)]));
  out.set(SCOREBOARD_PATH, renderScoreboardMarkdown());
  return out;
}

export function checkGeneratedMarkdown(): string[] {
  const problems: string[] = [];
  for (const [rel, generated] of renderAllCompatibilityMarkdown()) {
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
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (write) {
    for (const [rel, generated] of renderAllCompatibilityMarkdown()) {
      const path = join(REPO_ROOT, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated);
    }
    console.log(`Generated ${surfaceRegistries.length} compatibility document(s) + scoreboard.`);
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
