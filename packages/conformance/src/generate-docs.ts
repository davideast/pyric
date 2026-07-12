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
  diverged: number;
  unsupported: number;
  unverified: number;
  total: number;
  pct: number;
}

/**
 * The behavior conformance for a surface: the full status breakdown over its
 * evaluated rows. `diverged` counts `diverged-documented`; `pct` is the
 * conforming share, rounded. Every field is read from the baseline ledger.
 */
function computeBehavior(spec: SurfaceScoreSpec, base: CoverageBaseline): BehaviorScore {
  let conforms = 0;
  let diverged = 0;
  let unsupported = 0;
  let unverified = 0;
  let total = 0;
  for (const [key, status] of Object.entries(base.rowStatuses)) {
    const svc = key.slice(0, key.indexOf('#'));
    if (!spec.rowServices.includes(svc)) continue;
    total += 1;
    if (status === 'conforms') conforms += 1;
    else if (status === 'diverged-documented') diverged += 1;
    else if (status === 'unsupported') unsupported += 1;
    else if (status === 'unverified') unverified += 1;
  }
  const pct = total > 0 ? Math.round((conforms / total) * 100) : 0;
  return { conforms, diverged, unsupported, unverified, total, pct };
}

/** The bar segments for a score, one per non-empty bucket, `flex-grow` set to
 *  the count so the bar reads to scale. Segment `data-status` mirrors the
 *  `.compat-dot` status keys (conforms → `ok`). */
function statBar(score: BehaviorScore, extraClass = ''): string {
  const segs: Array<[string, number]> = [
    ['ok', score.conforms],
    ['diverged', score.diverged],
    ['unsupported', score.unsupported],
    ['unverified', score.unverified],
  ];
  const cls = extraClass ? `compat-stat-bar ${extraClass}` : 'compat-stat-bar';
  return [
    `<div class="${cls}">`,
    ...segs
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `<span class="compat-stat-seg" data-status="${status}" style="flex-grow: ${count}"></span>`),
    '</div>',
  ].join('\n');
}

/**
 * The data-journal stat block each surface doc leads with: the conformance
 * percentage as the figure, the count as the denominator, a to-scale bar, and
 * a key that ALWAYS lists all four buckets (including zeros) so "documented
 * differences" and "not yet supported" read as distinct and a gap can never be
 * mistaken for something unimplemented. Raw HTML the porter passes through.
 */
export function statBlock(surface: CompatibilitySurfaceRegistry): string | null {
  const spec = SCORE_SPECS[surface.surface];
  if (!spec) return null;
  const s = computeBehavior(spec, readArtifact(COVERAGE_BASELINE_PATH));
  return [
    '<div class="compat-stat">',
    `<p class="compat-stat-figure"><span class="compat-stat-pct">${s.pct}%</span><span class="compat-stat-label">match production Firebase</span></p>`,
    `<p class="compat-stat-denom">${s.conforms} of ${s.total} tracked behaviors</p>`,
    statBar(s),
    '<p class="compat-stat-key">',
    `<span class="compat-stat-item"><span class="compat-dot" data-status="ok"></span>${s.conforms} match</span>`,
    `<span class="compat-stat-item"><span class="compat-dot" data-status="diverged"></span>${s.diverged} documented differences</span>`,
    `<span class="compat-stat-item"><span class="compat-dot" data-status="unsupported"></span>${s.unsupported} not yet supported</span>`,
    `<span class="compat-stat-item"><span class="compat-dot" data-status="unverified"></span>${s.unverified} not yet verified</span>`,
    '</p>',
    '</div>',
  ].join('\n');
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

/**
 * The row's display label splits into an API name (the row heading) and a short
 * category sub-label. The `api` field carries them joined by ` — `; the part
 * before is the name, the part after is the category. A row with no ` — ` has an
 * empty category. When `api` is empty or is just the section string repeated, it
 * carries no per-row information, so the row has NO API name (an empty name — the
 * section heading already names the API, and a bare row ref would only mislead).
 */
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
  return `| ${escapeCell(name)} | ${escapeCell(category)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(row.evidence)} |`;
}

/**
 * The surface's blocks with the behavior stat block and shared status legend
 * injected under the H1 (the registry's first markdown block holds only the
 * H1). Both `renderSurfaceMarkdown` and `generatedRowLineNumbers` consume this
 * one block list, so they stay byte-for-byte in sync. A surface with no score
 * spec is unchanged.
 */
export function scoredBlocks(surface: CompatibilitySurfaceRegistry): CompatibilityDocBlock[] {
  const stat = statBlock(surface);
  return surface.blocks.map((block, index) => {
    if (index === 0 && block.kind === 'markdown') {
      // Each surface's authored H1 reads "… compatibility matrix"; the docs
      // call every matrix a conformance matrix, so the generator owns the
      // rename in one place rather than across the registry descriptors.
      const h1 = block.markdown.trim().replace('compatibility matrix', 'conformance matrix');
      const body = stat === null ? h1 : `${h1}\n\n${stat}\n\n${STATUS_LEGEND}`;
      return { ...block, markdown: `${body}\n` };
    }
    return block;
  });
}

/** The rows whose behavior is a pinned, documented difference from production
 *  (status `diverged-documented`), gathered so a reader sees every known gap in
 *  one place. Empty string when the surface has none. */
function divergedSection(rows: CompatibilityRow[]): string {
  if (rows.length === 0) return '';
  return [
    '## Documented differences',
    '',
    'Where the local engine and production Firebase differ today. Each difference is pinned and tracked.',
    '',
    '| API | Difference |',
    '|---|---|',
    ...rows.map((r) => `| ${escapeCell(apiParts(r).name)} | ${escapeCell(r.behavior)} |`),
    '',
  ].join('\n');
}

/** The rows a surface tracks but has not implemented yet (status `unsupported`,
 *  the `—` glyph), so a reader sees the gaps in one place instead of scanning
 *  the whole matrix. Empty string when nothing is pending. */
function notSupportedSection(rows: CompatibilityRow[]): string {
  if (rows.length === 0) return '';
  return [
    '## Not supported yet',
    '',
    'Tracked but not implemented yet. Each flips to ✓ as support lands.',
    '',
    '| API | Behavior |',
    '|---|---|',
    ...rows.map((r) => `| ${escapeCell(apiParts(r).name)} | ${escapeCell(r.behavior)} |`),
    '',
  ].join('\n');
}

/** The rows a surface tracks but has not yet checked against production (status
 *  `unverified`, the `?` glyph). Empty string when the surface has none. */
function notVerifiedSection(rows: CompatibilityRow[]): string {
  if (rows.length === 0) return '';
  return [
    '## Not verified yet',
    '',
    'Tracked but not yet checked against recorded production behavior.',
    '',
    '| API | Not yet verified |',
    '|---|---|',
    ...rows.map((r) => `| ${escapeCell(apiParts(r).name)} | ${escapeCell(r.behavior)} |`),
    '',
  ].join('\n');
}

/** The three consolidated status roundups in fixed order (documented
 *  differences, then not-supported, then not-verified), each present only when
 *  the surface has rows of that status. Rendered just above the deny-list. */
function consolidatedSections(rows: CompatibilityRow[]): string {
  return [
    divergedSection(rows.filter((r) => r.status === 'diverged-documented')),
    notSupportedSection(rows.filter((r) => r.status === 'unsupported')),
    notVerifiedSection(rows.filter((r) => r.status === 'unverified')),
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry): string {
  const parts: string[] = [GENERATED_HEADER, ''];
  const blocks = scoredBlocks(surface);
  const allRows = blocks.flatMap((b) => (b.kind === 'table' ? b.rows : []));
  const consolidated = consolidatedSections(allRows);
  let consolidatedInjected = false;
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'markdown') {
      // Inject the consolidated status roundups just above the first deny-list
      // block (both answer "what can't I use", kept together).
      if (!consolidatedInjected && consolidated && /deny-list/i.test(block.markdown)) {
        parts.push(consolidated);
        consolidatedInjected = true;
      }
      parts.push(block.markdown);
      continue;
    }
    parts.push(block.prefix);
    parts.push('| API | Category | Behavior | Status | Probe |');
    parts.push('|---|---|---|---|---|');
    for (const row of block.rows) parts.push(renderRow(row));
    const next = blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) parts.push('');
  }
  // No deny-list block (some surfaces have none): append at the end.
  if (!consolidatedInjected && consolidated) parts.push('', consolidated);
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
    lines.push('| API | Category | Behavior | Status | Probe |');
    lines.push('|---|---|---|---|---|');
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
 * How the scores are produced, appended under the scoreboard. Static prose
 * (the mirror is one-to-one, an observation is production pinned to a file),
 * so it lives as a constant rather than being computed. The closing link is a
 * raw-HTML `<a href>` to the ported ship-to-production slug: the porter's
 * markdown-link rewriter never touches raw HTML, so this final form survives
 * the port exactly like the scoreboard's own row links.
 */
const GH = 'https://github.com/davideast/pyric/tree/main/packages/conformance';
const GH_BLOB = 'https://github.com/davideast/pyric/blob/main/packages/conformance';

const SCOREBOARD_METHODOLOGY = [
  '## How does pyric know it works like Firebase?',
  '',
  '"Behaves like Firebase" is a claim anyone can print. Pyric earns it by making the claim falsifiable: every green row on these pages traces to a recording of real production, and a test that fails the build the moment the recording and the sandbox disagree.',
  '',
  'The mirror starts one to one. The call you write against Firebase is the call Pyric runs, character for character.',
  '',
  '```ts',
  "import { signInWithEmailAndPassword } from 'firebase/auth'; // production",
  "import { signInWithEmailAndPassword } from 'pyric/auth';    // development",
  '```',
  '',
  'So "does Pyric match?" reduces to one question asked once per behavior: did Pyric answer what production answered? To answer it, a probe runs the real call against a real Firebase project and records exactly what came back. That recording is an oracle observation, committed to the repository:',
  '',
  '```json',
  '{',
  '  "name": "auth-wrong-password-error-code",',
  '  "rowIds": ["auth#15"],',
  '  "fbSdkVersion": "12.13.0",',
  '  "behavior": {',
  '    "code": "auth/wrong-password",',
  '    "messageContains": { "wrongPassword": true, "invalidCredential": false }',
  '  }',
  '}',
  '```',
  '',
  `That one file (${'[auth-wrong-password-error-code.json]'}(${GH_BLOB}/observations/auth/auth-wrong-password-error-code.json)) pins what a wrong password throws, and it locks row \`auth#15\` on the Auth matrix. Every verified behavior has its own, under [observations/](${GH}/observations). The [registry](${GH}/registry) maps each recording to a numbered row, and \`compat:check\` replays every recording against the sandbox on each change. If the sandbox answers differently than production did, the build fails before the change lands. Recapturing a recording is the drift check: an unchanged file means production still behaves as pinned; a changed file means the behavior moved, and the git diff is the report.`,
  '',
  `Security Rules work the same way from the other direction. A [corpus](${GH}/rules-corpus) of rulesets and requests is evaluated against Google's own Rules Test API, and the sandbox simulator has to reach the same verdict, case for case. The [probes](${GH}/probes) that capture production and the [runner](${GH_BLOB}/src/run.ts) that replays it are all in the open.`,
  '',
  '### What this does not prove',
  '',
  'This is the honest part. Conformance measured this way is a floor, not a guarantee of total equivalence.',
  '',
  '- **It covers only what has been recorded.** A behavior with no observation is marked not yet verified, never assumed to match. Those rows are shown on the matrices, not hidden.',
  '- **Recordings are snapshots.** Each pins one SDK version against one project\'s configuration. A behavior that depends on config the oracle project does not have goes uncaught until it is recorded. `fetchSignInMethodsForEmail` is a real case: the oracle project had the password provider disabled, so the capture proved nothing, and the call is left unimplemented on the strength of the SDK\'s own type declaration instead.',
  '- **The row universe is not all of Firebase.** These matrices track the behaviors someone thought to probe. Firebase surface that no one has exercised is not on the board, and absence from the board is not a pass.',
  '- **The proof is uneven.** Auth, Firestore, and Rules are pinned deeply. Realtime Database and Storage are earlier, with fewer recordings, and Realtime Database rules are the thinnest of all. The scores above say where the ground is solid and where it is still early, on purpose.',
  '',
  'Put the claim under load yourself: run the app, break a rule, and compare the verdict against production in <a href="../ship-to-production/">ship to production</a>.',
].join('\n');

/**
 * The directory-relative href from the scoreboard to a surface's COMPAT page.
 * The port (port-content.ts `slugFor`) slugs each page as `pyric-<dir>-compat`
 * and rewrites intra-doc links to `../<slug>/`; the scoreboard authors that
 * final form directly because it lives in a raw-HTML `<a href>`, which the
 * porter's markdown-link rewriter never touches.
 */
function scoreboardHref(compatPath: string | undefined): string {
  const dir = compatPath?.match(/packages\/pyric\/docs\/(.+)\/COMPAT\.md$/)?.[1] ?? '';
  return `../pyric-${dir}-compat/`;
}

/**
 * The central scoreboard doc: one linked row per surface, its conformance
 * percentage prominent, with a to-scale mini bar in the same visual language
 * as the per-surface stat blocks. Every number is read from the baseline
 * ledger at generate time, never asserted here.
 */
export function renderScoreboardMarkdown(): string {
  const base = readArtifact<CoverageBaseline>(COVERAGE_BASELINE_PATH);
  const compatPathBySurface = new Map(surfaceRegistries.map((s) => [s.surface, s.compatPath]));

  const lines: string[] = [
    GENERATED_HEADER,
    '',
    '# Conformance',
    '',
    '<div class="compat-scoreboard">',
  ];

  for (const key of SCOREBOARD_SURFACE_ORDER) {
    const spec = SCORE_SPECS[key];
    if (!spec) continue;
    const score = computeBehavior(spec, base);
    lines.push(
      `<a class="compat-score-row" href="${scoreboardHref(compatPathBySurface.get(key))}">`,
      `<span class="compat-score-name">${spec.label}</span>`,
      `<span class="compat-score-pct">${score.pct}%</span>`,
      statBar(score, 'compat-stat-bar--mini'),
      '</a>',
    );
  }

  lines.push(
    '</div>',
    '',
    'Auth, Firestore, and Rules are held to recorded production behavior. Realtime Database and Storage are earlier and pinned to fewer production observations.',
    '',
    SCOREBOARD_METHODOLOGY,
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
