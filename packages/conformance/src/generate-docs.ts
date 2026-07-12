#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowsForSurface, surfaceRegistries, type CompatibilityRow, type CompatibilitySurfaceRegistry, type CompatStatus } from '../registry/index.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';

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

// ── Conformance scores (generated from the score artifacts) ─────────────────
//
// The per-surface COMPAT matrices carry row-by-row status. The aggregate
// scores (SDK surface breadth, behavior conformance, rules-language coverage,
// assurance) live in three artifacts, never asserted in prose. This section
// reads those artifacts and renders (a) one central scoreboard doc and (b) a
// compact score header injected above each surface's status legend. Every
// number here is computed at generate time; `--check` re-reads the same
// artifacts, so a doc that drifts from them fails the gate.

/** The generated central scoreboard, ported into the Compatibility nav group. */
export const SCOREBOARD_PATH = 'packages/pyric/docs/conformance/SCORES.md';

const COVERAGE_BASELINE_PATH = 'packages/conformance/baselines/coverage-baseline.json';
const RULES_LANGUAGE_PATH = 'packages/conformance/rules-language/coverage-report.json';
const CAPABILITIES_PATH = 'packages/conformance/assurance-capabilities/capabilities.json';
const REGEN_COMMAND = '`bun run compat:generate`';

interface CoverageBaseline {
  services: Record<string, { surfaceCoveragePct?: { total: number; intended: number }; native?: boolean }>;
  overall: { surfaceCoveragePct: { total: number; intended: number } };
  rowStatuses: Record<string, string>;
}
interface RulesEngineReport {
  engine: string;
  totalConstructs: number;
  verifiedConstructs: number;
  verifiedCoverage: number;
}
interface RulesLanguageReport {
  engines: RulesEngineReport[];
}
interface AssuranceCapability {
  id: string;
  service: string;
  status: 'supported' | 'qualified' | 'unsupported';
}
interface CapabilitiesReport {
  capabilities: AssuranceCapability[];
}

function readArtifact<T>(rel: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as T;
}

/** One surface's mapping onto the score artifacts. Keyed by the registry's `surface`. */
interface SurfaceScoreSpec {
  label: string;
  /** `base.services` key for SDK breadth; empty = native surface (no upstream denominator). */
  coverageService: string | null;
  coverageNote?: string;
  /** `rowStatuses` service prefixes whose behavior rows this surface owns. */
  rowServices: string[];
  /** A behavior slice this page owns that is not yet in the baseline ledger. */
  rowsMissingNote?: string;
  /** `rules-language` engine keys this surface adjudicates. */
  rulesEngines: string[];
  /** `capabilities.service` keys this surface underwrites. */
  capServices: string[];
  /** The rules surface is the engine behind every capability: roll up all of them. */
  capAllEngines?: boolean;
}

/** Non-conforming statuses in the order a breakdown lists them. */
const NONCONFORMING_ORDER = ['bug', 'diverged-documented', 'unsupported', 'unverified'];

const RULES_ENGINE_LABEL: Record<string, string> = {
  firestore: 'Firestore',
  storage: 'Storage',
  rtdb: 'RTDB',
};

/**
 * The mapping from each generated COMPAT doc (keyed by its registry `surface`)
 * onto the artifacts. The `rowStatuses` service keys do NOT line up 1:1 with
 * the surfaces: `database` owns `rtdb` + `rtdb-modular`, `messaging` owns
 * `messaging` + `messaging-admin`, `rules` owns `firestore-rules` +
 * `storage-rules` (its `rtdb-rules` behavior rows are not yet in the baseline
 * ledger). Maturity comes from the surface descriptor, not this map.
 */
const SCORE_SPECS: Record<string, SurfaceScoreSpec> = {
  app: {
    label: 'App',
    coverageService: 'app',
    rowServices: ['app'],
    rulesEngines: [],
    capServices: [],
  },
  ai: {
    label: 'AI Logic',
    coverageService: 'ai',
    rowServices: ['ai'],
    rulesEngines: [],
    capServices: [],
  },
  auth: {
    label: 'Auth',
    coverageService: 'auth',
    rowServices: ['auth'],
    rulesEngines: [],
    capServices: ['auth'],
  },
  firestore: {
    label: 'Firestore',
    coverageService: 'firestore',
    rowServices: ['firestore'],
    rulesEngines: [],
    capServices: ['firestore'],
  },
  rtdb: {
    label: 'Realtime Database',
    coverageService: 'rtdb-modular',
    coverageNote: 'modular SDK surface; the agent-tool surface is native',
    rowServices: ['rtdb', 'rtdb-modular'],
    rulesEngines: [],
    capServices: ['rtdb'],
  },
  storage: {
    label: 'Storage',
    coverageService: 'storage',
    rowServices: ['storage'],
    rulesEngines: [],
    capServices: ['storage'],
  },
  messaging: {
    label: 'Messaging',
    coverageService: 'messaging',
    coverageNote: 'client receive plane; the admin send plane has no separate breadth entry',
    rowServices: ['messaging', 'messaging-admin'],
    rulesEngines: [],
    capServices: [],
    maturity: 'Experimental (not yet in published packages)',
  },
  rules: {
    label: 'Rules',
    coverageService: null,
    coverageNote: 'no upstream module, so no breadth denominator',
    rowServices: ['firestore-rules', 'storage-rules'],
    rowsMissingNote: 'the RTDB rules engine behavior rows are not yet in the baseline ledger',
    rulesEngines: ['firestore', 'storage', 'rtdb'],
    capServices: [],
    capAllEngines: true,
  },
};

interface SurfaceScores {
  spec: SurfaceScoreSpec;
  coverage: DimensionScore;
  behavior: DimensionScore;
  rules: RulesScore | null;
  assurance: DimensionScore | null;
}

/** Reader-facing wording for a non-conforming status, singular/plural aware. */
function nonconformingPhrase(status: string, n: number): string {
  if (status === 'diverged-documented') return `${n} documented divergence${n === 1 ? '' : 's'}`;
  if (status === 'bug') return `${n} bug${n === 1 ? '' : 's'}`;
  return `${n} ${status}`;
}

/** Order a behavior breakdown reads in. */
const BEHAVIOR_BREAKDOWN_ORDER = ['diverged-documented', 'unsupported', 'unverified', 'bug'];

/** A scored dimension: `cell` for the central master table, `value` for the per-surface table. */
interface DimensionScore {
  cell: string;
  value: string;
}

function computeCoverage(spec: SurfaceScoreSpec, base: CoverageBaseline): DimensionScore {
  if (!spec.coverageService) {
    const note = spec.coverageNote ?? 'no upstream module, no breadth denominator';
    return { cell: `Native (${note})`, value: `native surface (${note})` };
  }
  const cov = base.services[spec.coverageService]?.surfaceCoveragePct;
  if (!cov) return { cell: 'not in the baseline', value: 'not yet in the baseline' };
  const note = spec.coverageNote ? ` (${spec.coverageNote})` : '';
  return {
    cell: `${cov.total}% total / ${cov.intended}% intended`,
    value: `${cov.total}% of total surface, ${cov.intended}% of intended surface${note}`,
  };
}

function computeBehavior(spec: SurfaceScoreSpec, base: CoverageBaseline): DimensionScore {
  const counts: Record<string, number> = {};
  for (const [key, status] of Object.entries(base.rowStatuses)) {
    const svc = key.slice(0, key.indexOf('#'));
    if (spec.rowServices.includes(svc)) counts[status] = (counts[status] ?? 0) + 1;
  }
  const conforms = counts['conforms'] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rawBreakdown = NONCONFORMING_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  const prettyBreakdown = BEHAVIOR_BREAKDOWN_ORDER.filter((s) => counts[s]).map((s) => nonconformingPhrase(s, counts[s]));
  const missing = spec.rowsMissingNote ? `; ${spec.rowsMissingNote}` : '';
  // Lead with the percentage: it is the headline trust number, not the raw fraction.
  const pct = total > 0 ? `${((conforms / total) * 100).toFixed(1)}%` : '—';
  return {
    cell: `${pct} (${conforms} / ${total})`,
    value: `${pct} conform, ${conforms} of ${total} rows${prettyBreakdown.length ? ` (${prettyBreakdown.join(', ')})` : ''}${missing}`,
  };
}

interface RulesScore extends DimensionScore {
  /** One entry per engine for the per-surface table. */
  engines: { engine: string; value: string }[];
}

function computeRules(spec: SurfaceScoreSpec, rules: RulesLanguageReport): RulesScore | null {
  if (spec.rulesEngines.length === 0) return null;
  const byEngine = new Map(rules.engines.map((e) => [e.engine, e]));
  const engines = spec.rulesEngines
    .map((name) => {
      const e = byEngine.get(name);
      if (!e) return null;
      const pct = (e.verifiedCoverage * 100).toFixed(1);
      const label = RULES_ENGINE_LABEL[name] ?? name;
      return { engine: label, value: `${e.verifiedConstructs} / ${e.totalConstructs} constructs (${pct}%)` };
    })
    .filter((e): e is { engine: string; value: string } => e !== null);
  if (engines.length === 0) return null;
  const cell = engines.map((e) => `${e.engine} ${e.value}`).join('; ');
  return { cell, value: cell, engines };
}

function computeAssurance(spec: SurfaceScoreSpec, caps: CapabilitiesReport): DimensionScore | null {
  const list = spec.capAllEngines
    ? caps.capabilities
    : caps.capabilities.filter((c) => spec.capServices.includes(c.service));
  if (list.length === 0) return null;
  const supported = list.filter((c) => c.status === 'supported').length;
  const qualified = list.filter((c) => c.status === 'qualified').length;
  const unsupported = list.filter((c) => c.status === 'unsupported').length;
  const parts = [`${supported} supported`, qualified ? `${qualified} qualified` : '', unsupported ? `${unsupported} unsupported` : '']
    .filter(Boolean)
    .join(', ');
  const extras = [qualified ? `${qualified} qualified` : '', unsupported ? `${unsupported} unsupported` : '']
    .filter(Boolean)
    .join(', ');
  return {
    cell: `${supported} / ${list.length} supported${extras ? ` (${extras})` : ''}`,
    value: `${parts} (of ${list.length})`,
  };
}

function scoresForSpec(spec: SurfaceScoreSpec, base: CoverageBaseline, rules: RulesLanguageReport, caps: CapabilitiesReport): SurfaceScores {
  return {
    spec,
    coverage: computeCoverage(spec, base),
    behavior: computeBehavior(spec, base),
    rules: computeRules(spec, rules),
    assurance: computeAssurance(spec, caps),
  };
}

/** The maturity tag for a surface, read from its descriptor (not asserted in prose). */
export function maturityForSurface(surface: CompatibilitySurfaceRegistry): string {
  const descriptor = surfaceDescriptors.find((d) => d.registry === surface);
  if (!descriptor?.maturity) throw new Error(`no descriptor maturity for surface ${surface.surface}`);
  return descriptor.maturity;
}

/** Rows on a surface that cite a live-prod oracle observation, over its total rows. */
function captureState(surface: CompatibilitySurfaceRegistry): { cited: number; total: number } {
  const rows = rowsForSurface(surface);
  return { cited: rows.filter((r) => (r.oracleObservations?.length ?? 0) > 0).length, total: rows.length };
}

/**
 * The formal header injected below the H1 and above the status legend: a
 * compact metric/value table so every score is scannable at a glance, then one
 * line naming the generator and linking the central rollup. Each surface shows
 * only the rows that apply to it (a non-rules surface omits the rules-language
 * rows). Every value is data-derived. Empty for a surface with no score spec.
 */
export function formalHeaderLines(surface: CompatibilitySurfaceRegistry): string[] {
  const spec = SCORE_SPECS[surface.surface];
  if (!spec) return [];
  const scores = scoresForSpec(spec, readArtifact(COVERAGE_BASELINE_PATH), readArtifact(RULES_LANGUAGE_PATH), readArtifact(CAPABILITIES_PATH));
  const capture = captureState(surface);
  const rows: [string, string][] = [
    ['Maturity', maturityForSurface(surface)],
    ['SDK surface coverage', scores.coverage.value],
    ['Behavior conformance', scores.behavior.value],
  ];
  if (scores.rules) for (const e of scores.rules.engines) rows.push([`Rules-language, ${e.engine}`, e.value]);
  if (scores.assurance) rows.push(['Assurance capabilities', scores.assurance.value]);
  rows.push(['Live-prod oracle citations', `${capture.cited} / ${capture.total} rows`]);
  return [
    '| Metric | Value |',
    '|---|---|',
    ...rows.map(([metric, value]) => `| ${escapeCell(metric)} | ${escapeCell(value)} |`),
    '',
    `Generated by ${REGEN_COMMAND}. Full rollup: [Conformance scores by surface](../conformance/SCORES.md).`,
  ];
}

function renderStatus(row: CompatibilityRow): string {
  const glyph = STATUS_GLYPHS[row.status];
  return row.statusNote ? `${glyph} ${row.statusNote}` : glyph;
}

function renderRow(row: CompatibilityRow): string {
  return `| ${escapeCell(row.rowRef)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(row.evidence)} |`;
}

const SCORE_LEGEND_MARKER = '## Status legend';

/**
 * The surface's blocks with the compact score header injected above the status
 * legend (below the H1/intro), so both `renderSurfaceMarkdown` and
 * `generatedRowLineNumbers` see one block list and stay byte-for-byte in sync.
 * A surface with no score spec, or whose intro has no legend, is unchanged.
 */
export function scoredBlocks(surface: CompatibilitySurfaceRegistry): CompatibilityDocBlock[] {
  const header = formalHeaderLines(surface);
  if (header.length === 0) return surface.blocks;
  const headerText = header.join('\n');
  return surface.blocks.map((block) => {
    if (block.kind === 'markdown' && block.markdown.includes(SCORE_LEGEND_MARKER) && !block.markdown.includes(headerText)) {
      return { ...block, markdown: block.markdown.replace(SCORE_LEGEND_MARKER, `${headerText}\n\n${SCORE_LEGEND_MARKER}`) };
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

const DOCS_ROOT_PREFIX = 'packages/pyric/docs/';

/** Relative link from the scoreboard (`conformance/SCORES.md`) to a surface's COMPAT doc. */
function compatLinkFromScoreboard(compatPath: string): string {
  return `../${compatPath.startsWith(DOCS_ROOT_PREFIX) ? compatPath.slice(DOCS_ROOT_PREFIX.length) : compatPath}`;
}

/**
 * The central scoreboard doc: one master table of every surface's aggregate
 * scores, then a section per dimension naming its denominator. Every number is
 * read from the artifacts at generate time, never asserted here.
 */
export function renderScoreboardMarkdown(): string {
  const base = readArtifact<CoverageBaseline>(COVERAGE_BASELINE_PATH);
  const rules = readArtifact<RulesLanguageReport>(RULES_LANGUAGE_PATH);
  const caps = readArtifact<CapabilitiesReport>(CAPABILITIES_PATH);

  const rows = surfaceRegistries
    .map((surface) => ({ surface, spec: SCORE_SPECS[surface.surface] }))
    .filter((entry): entry is { surface: CompatibilitySurfaceRegistry; spec: SurfaceScoreSpec } => entry.spec !== undefined)
    .map(({ surface, spec }) => ({ surface, spec, scores: scoresForSpec(spec, base, rules, caps) }));

  const overall = base.overall.surfaceCoveragePct;

  const lines: string[] = [
    GENERATED_HEADER,
    '',
    '# Conformance scores by surface',
    '',
    '| Surface | SDK surface coverage (total / intended) | Behavior conforming (conforms / evaluated) | Rules-language verified (verified / attributable) | Assurance (supported / total) | Maturity |',
    '|---|---|---|---|---|---|',
  ];

  for (const { surface, spec, scores } of rows) {
    const link = compatLinkFromScoreboard(surface.compatPath);
    lines.push(
      `| [${escapeCell(spec.label)}](${link}) | ${escapeCell(scores.coverage.cell)} | ${escapeCell(scores.behavior.cell)} | ${escapeCell(scores.rules ? scores.rules.cell : '—')} | ${escapeCell(scores.assurance ? scores.assurance.cell : '—')} | ${escapeCell(maturityForSurface(surface))} |`,
    );
  }

  lines.push(
    '',
    `Generated by ${REGEN_COMMAND} from \`${COVERAGE_BASELINE_PATH}\`, \`${RULES_LANGUAGE_PATH}\`, and \`${CAPABILITIES_PATH}\`. Editing this file by hand does nothing; the numbers come from the artifacts.`,
    '',
    '## SDK surface coverage',
    '',
    `The share of the upstream SDK surface Pyric mirrors, measured by symbol census. \`total\` counts every public symbol on the upstream module. \`intended\` narrows the denominator to the symbols in scope for Pyric (it drops the symbols deliberately left out, such as persistence caches or phone auth), so it reads higher. A native surface has no upstream module and so no breadth denominator. Across every measured surface, breadth is ${overall.total}% of the total surface and ${overall.intended}% of the intended surface.`,
    '',
    '## Behavior conformance',
    '',
    'The share of a surface\'s behavior rows whose recorded status is `conforms`. The denominator is the rows currently evaluated in the baseline ledger (`rowStatuses`), not the full authored row universe. The parenthetical names the non-conforming statuses: `diverged-documented` is a known, written-up difference; `unsupported` is not modeled yet; `unverified` is claimed but not yet observed against production; `bug` should match but does not.',
    '',
    '## Rules-language coverage',
    '',
    'For the rules engines only: the share of attributable rules-language constructs exercised by at least one corpus scenario that has a production observation twin. The denominator is the attributable constructs per engine (a pure meta-semantic with no AST representation, such as deny-by-default, is excluded because static analysis can never credit it). Firestore and Storage read verdicts from the server-side Rules Test API; RTDB has no such API, so its verdicts come from deploy-observe-restore against a live oracle database.',
    '',
    '## Assurance capabilities',
    '',
    'Whether the rules engine can vouch for a security probe end to end. `supported` means the engine underwrites the conclusion; `qualified` means it underwrites it with a caveat; `unsupported` means the engine abstains because a dependency has a gap, so the probe reports engine-gap rather than a security verdict. The capabilities are derived from the rules engines and attributed to the data service each protects, which is why the Rules row rolls up every capability while each data-service row shows its own slice.',
    '',
    '## Maturity',
    '',
    'Auth, Firestore, and Rules are v1 and conformance-held: proven against recorded production behavior and safe to trust today. Realtime Database and Storage are experimental: they work and are documented, but most of their behavior is not yet pinned to a production observation. AI Logic climbed under Conformance Driven Development and is not yet v1. Messaging is conformance-held in this repository but not yet in the published packages. App is the initialization surface every other surface sits on, shipped in the packages.',
    '',
    '## Per-surface matrices',
    '',
    ...rows.map(({ surface, spec }) => `- [${spec.label}](${compatLinkFromScoreboard(surface.compatPath)})`),
    '',
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
