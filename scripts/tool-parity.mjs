#!/usr/bin/env bun
/**
 * Tool-registry parity audit (TOOL-SYSTEM.md, "Exposure matrix").
 *
 * Enumerates the two tool surfaces by static extraction and emits the
 * exposure matrix mechanically, so drift is detected rather than
 * remembered:
 *
 *   1. MCP bridge (sandbox mode) — the folded tools under
 *      packages/cli/src/bridge/tool-records/: one record per tool, each
 *      operation naming the handler that implements it. Rows are keyed
 *      `tool.op`; the handler name joins them to the playground surface.
 *   2. Playground agent — what
 *      packages/playground/src/lib/tools/index.ts's buildToolRegistry()
 *      registers: core / auth / git / checkpoints always-on, diagnostics
 *      flag-gated, skill tools skill-gated. Profile filtering
 *      (AUTHORING_TOOL_NAMES) is parsed from source, not restated here.
 *
 * Extraction is static: records are read for their `name`, `op`, `factory`
 * and `handler` literals; handler `name: '...'` literals are read out of the
 * factory function bodies that each factory key points at. The factory
 * manifest below MIRRORS packages/cli/src/bridge/server/tool-factories.ts; a
 * freshness guard re-reads that file and fails if it references a factory
 * the manifest does not cover, and every record handler must be one its
 * factory defines, so additions break the audit loudly instead of silently
 * vanishing from the matrix.
 *
 * Classification comes from scripts/tool-parity.annotations.json —
 * every row's exposure decision must be recorded there ("gap" or
 * "deliberate"). Unannotated rows report as "unclassified", and
 * `--check` exits nonzero if any exist, so CI can force a recorded
 * decision for every new tool.
 *
 * Usage:
 *   bun run scripts/tool-parity.mjs            # print matrix
 *   bun run scripts/tool-parity.mjs --check    # nonzero exit on unclassified
 *   bun run scripts/tool-parity.mjs --out FILE # also write matrix to FILE
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── extraction primitives ────────────────────────────────────────────

const NAME_RE = /^\s*name:\s*["']([a-z][a-z0-9_]{2,})["']/gm;

function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** All snake_case `name: '...'` literals in a source string. */
function namesIn(source) {
  return [...source.matchAll(NAME_RE)].map((m) => m[1]);
}

/**
 * Extract the body of `export function <factoryName>(...)` via brace
 * matching. Throws if the factory is missing — a rename upstream must
 * fail the audit, not silently drop a surface.
 */
function factoryBody(source, factoryName, rel) {
  const declRe = new RegExp(`export\\s+(?:async\\s+)?function\\s+${factoryName}\\b`);
  const m = declRe.exec(source);
  if (!m) {
    throw new Error(`tool-parity: factory ${factoryName} not found in ${rel} — extraction manifest is stale`);
  }
  // Find the body's opening brace: the first `{` outside the parameter
  // list (paren depth 0), so default params like `deps = {}` don't fool
  // the brace matcher.
  let open = -1;
  let parens = 0;
  for (let i = m.index + m[0].length; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '{' && parens === 0) {
      open = i;
      break;
    }
  }
  if (open === -1) throw new Error(`tool-parity: no body found for ${factoryName} in ${rel}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`tool-parity: unbalanced braces walking ${factoryName} in ${rel}`);
}

/** Tool names contributed by one exported factory function. */
function factoryNames(rel, factoryName) {
  const names = namesIn(factoryBody(read(rel), factoryName, rel));
  if (names.length === 0) {
    throw new Error(`tool-parity: ${factoryName} in ${rel} yielded zero tool names — extraction broke`);
  }
  return names;
}

// ─── surface manifests ────────────────────────────────────────────────
// Each entry mirrors one contribution in the real composition code and
// cites where. `gate` is the exposure condition; `pick` narrows to the
// subset the composition actually registers.

const PYRIC = 'packages/pyric/src';
const TOOLS = 'packages/cli/src';
const PLAY = 'packages/playground/src/lib';

/** The one bridge file that names every MCP handler factory; the freshness guard reads it. */
export const MCP_COMPOSITION_FILE = `${TOOLS}/bridge/server/tool-factories.ts`;

/** Directory of one record per folded MCP tool. */
export const MCP_RECORDS_DIR = `${TOOLS}/bridge/tool-records`;

/**
 * MCP handler factories keyed as the records name them — mirrors
 * bridge/server/tool-factories.ts. Each entry lists every factory whose
 * handlers the key yields (the rules factory spreads the stdlib factory).
 */
const MCP_FACTORIES = {
  'firestore-simulator': [{ file: `${PYRIC}/rules/simulator-tools-impl.ts`, factory: 'createFirestoreSimulatorTools' }],
  'firestore-data': [{ file: `${PYRIC}/firestore/tools.ts`, factory: 'createFirestoreDataTools' }],
  'firestore-inspect': [{ file: `${PYRIC}/firestore/tools.ts`, factory: 'createFirestoreInspectTools' }],
  'rtdb-inspection': [{ file: `${TOOLS}/rtdb/inspection.ts`, factory: 'createRtdbInspectionTools' }],
  'firestore-rules': [
    { file: `${PYRIC}/rules/tools.ts`, factory: 'createFirestoreRulesTools' },
    { file: `${PYRIC}/rules/stdlib-tools.ts`, factory: 'createFirestoreRulesStdlibTools' },
  ],
  'firestore-indexes': [{ file: `${PYRIC}/rules/indexes/tools.ts`, factory: 'createFirestoreIndexesTools' }],
  // createConformanceTools registers the shared createCanIUseTool factory,
  // which owns the name literal for both the MCP and Playground surfaces.
  conformance: [{ file: `${TOOLS}/conformance/can-i-use-tool.ts`, factory: 'createCanIUseTool' }],
  verify: [{ file: `${TOOLS}/verify/tools.ts`, factory: 'createVerifyTools' }],
};

/**
 * Playground agent — mirrors lib/tools/index.ts buildToolRegistry().
 * Extraction is a directory sweep for `name:` literals, with explicit
 * entries for wrapper files that register SDK factories (they carry no
 * name literal of their own) and for files whose registration gate does
 * not match their directory.
 */
const PLAYGROUND_DIRS = [
  { dir: `${PLAY}/tools/core`, gate: 'always-on' },
  { dir: `${PLAY}/tools/auth`, gate: 'always-on' },
  { dir: `${PLAY}/tools/git`, gate: 'always-on (self-gates on PAT + linked repo)' },
  { dir: `${PLAY}/tools/diagnostics`, gate: 'flag-gated (pyricDiagnosticsEnabled + per-tool flag)' },
  { dir: `${PLAY}/tools/skills`, gate: 'skill-gated (active-skill chip)' },
];

/** file (relative to repo root) → override gate. */
const PLAYGROUND_FILE_GATES = {
  // Registered in CORE_TOOLS despite living under diagnostics/.
  [`${PLAY}/tools/diagnostics/seed-firestore-data.ts`]: 'always-on',
};

/** Wrapper files: playground modules that register factories defined
 *  elsewhere. `pick` narrows to what the wrapper actually registers. */
const PLAYGROUND_WRAPPERS = {
  [`${PLAY}/tools/core/firestoreExtractIndexes.ts`]: {
    file: `${PYRIC}/rules/indexes/extractTool.ts`,
    factory: 'createFirestoreExtractTool',
    gate: 'always-on',
  },
  [`${PLAY}/tools/core/can-i-use.ts`]: {
    file: `${TOOLS}/conformance/can-i-use-tool.ts`,
    factory: 'createCanIUseTool',
    gate: 'always-on',
  },
  [`${PLAY}/tools/core/firestoreRulesStdlib.ts`]: {
    file: `${PYRIC}/rules/stdlib-tools.ts`,
    factory: 'createFirestoreRulesStdlibTools',
    pick: [
      'firestore_rules_stdlib_list',
      'firestore_rules_stdlib_get',
      'rules_stdlib_list',
      'rules_stdlib_get',
    ],
    gate: 'always-on',
  },
};

/** Standalone playground tool modules registered outside lib/tools. */
const PLAYGROUND_EXTRA_FILES = [
  { file: `${PLAY}/checkpoints/tool.ts`, gate: 'always-on' },
];

// ─── freshness guards ─────────────────────────────────────────────────
// The manifests above restate composition code. These guards re-read the
// composition files and fail when they reference factories the manifests
// do not cover, so new contributions cannot silently skip the audit.

const FACTORY_CALL_RE = /\bcreate[A-Z][A-Za-z]*Tool(?:s)?\b/g;

function assertCovered(rel, covered, { ignore = [] } = {}) {
  const referenced = new Set(read(rel).match(FACTORY_CALL_RE) ?? []);
  for (const name of ignore) referenced.delete(name);
  if (referenced.size === 0) {
    throw new Error(
      `tool-parity: ${rel} references no tool factory — the freshness guard target is stale`,
    );
  }
  const missing = [...referenced].filter((f) => !covered.has(f));
  if (missing.length > 0) {
    throw new Error(
      `tool-parity: ${rel} references factories not covered by the audit manifest: ${missing.join(', ')}. ` +
        'Add them to scripts/tool-parity.mjs so the new tools appear in the parity matrix.',
    );
  }
}

function checkFreshness() {
  const covered = new Set(
    Object.values(MCP_FACTORIES).flatMap((sources) => sources.map((s) => s.factory)),
  );
  // The bridge composes createConformanceTools, which delegates its one name
  // literal to createCanIUseTool; the manifest points at the owner.
  covered.add('createConformanceTools');
  assertCovered(MCP_COMPOSITION_FILE, covered);
  // Playground: every wrapper-style tool module (builder export, no name
  // literal) must have an explicit entry, or its tools would be missed.
  for (const { dir } of PLAYGROUND_DIRS) {
    for (const rel of sweepFiles(dir)) {
      const src = read(rel);
      if (namesIn(src).length > 0) continue;
      const definesBuilder = /export function build[A-Z]\w*Handler/.test(src);
      if (definesBuilder && !PLAYGROUND_WRAPPERS[rel]) {
        throw new Error(
          `tool-parity: ${rel} looks like a tool wrapper (builder export, no name literal) ` +
            'but has no PLAYGROUND_WRAPPERS entry — its tools would be missing from the matrix.',
        );
      }
    }
  }
}

// ─── surface enumeration ──────────────────────────────────────────────

function sweepFiles(dirRel) {
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, dirRel), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(`${dirRel}/${entry.name}`);
  }
  return out.sort();
}

/** name → gate string, first gate wins (duplicates keep both, joined). */
function addTool(surface, name, gate) {
  const prior = surface.get(name);
  surface.set(name, prior && prior !== gate ? `${prior}; ${gate}` : gate);
}

const RECORD_NAME_RE = /^\s*name:\s*'([a-z][a-z0-9_]*)'/m;
const RECORD_OP_RE =
  /^\s{4}([a-z][a-z0-9_]*):\s*\{[^}]*?transport:\s*'(forwarded|in-process)'[^}]*?factory:\s*'([a-z0-9-]+)'[^}]*?handler:\s*'([a-z][a-z0-9_]*)'/gms;

/**
 * Read one tool record statically: its tool name and, per op, transport,
 * factory key and handler name.
 */
export function readToolRecord(rel) {
  const source = read(rel);
  const name = RECORD_NAME_RE.exec(source)?.[1];
  if (!name) throw new Error(`tool-parity: ${rel} declares no tool name`);
  const ops = [...source.matchAll(RECORD_OP_RE)].map((m) => ({
    op: m[1],
    transport: m[2],
    factory: m[3],
    handler: m[4],
  }));
  if (ops.length === 0) throw new Error(`tool-parity: ${rel} declares no ops — extraction broke`);
  return { name, ops };
}

/**
 * MCP surface: `tool.op` → { gate, handler }. Every op's handler must be a
 * name its factory defines, so a record that drifts from its factory fails
 * the audit.
 */
export function enumerateMcp() {
  const handlersByFactory = new Map();
  for (const [key, sources] of Object.entries(MCP_FACTORIES)) {
    handlersByFactory.set(key, new Set(sources.flatMap((s) => factoryNames(s.file, s.factory))));
  }
  const surface = new Map();
  for (const rel of sweepFiles(MCP_RECORDS_DIR)) {
    const record = readToolRecord(rel);
    for (const op of record.ops) {
      const handlers = handlersByFactory.get(op.factory);
      if (!handlers) {
        throw new Error(`tool-parity: ${rel} op ${op.op} names factory '${op.factory}', which the manifest does not cover`);
      }
      if (!handlers.has(op.handler)) {
        throw new Error(`tool-parity: ${rel} op ${op.op} names handler '${op.handler}', which factory '${op.factory}' does not define`);
      }
      surface.set(`${record.name}.${op.op}`, { gate: op.transport, handler: op.handler });
    }
  }
  return surface;
}

export function enumeratePlayground() {
  const surface = new Map();
  for (const { dir, gate } of PLAYGROUND_DIRS) {
    for (const rel of sweepFiles(dir)) {
      const fileGate = PLAYGROUND_FILE_GATES[rel] ?? gate;
      for (const name of namesIn(read(rel))) addTool(surface, name, fileGate);
    }
  }
  for (const [rel, w] of Object.entries(PLAYGROUND_WRAPPERS)) {
    let names = factoryNames(w.file, w.factory);
    if (w.pick) {
      const missing = w.pick.filter((n) => !names.includes(n));
      if (missing.length > 0) {
        throw new Error(`tool-parity: ${rel} picks ${missing.join(', ')} but ${w.factory} no longer defines them`);
      }
      names = w.pick;
    }
    for (const name of names) addTool(surface, name, w.gate);
  }
  for (const { file, gate } of PLAYGROUND_EXTRA_FILES) {
    for (const name of namesIn(read(file))) addTool(surface, name, gate);
  }
  return surface;
}

// ─── annotations + matrix ─────────────────────────────────────────────

export const ANNOTATIONS_PATH = 'scripts/tool-parity.annotations.json';

export function loadAnnotations() {
  const parsed = JSON.parse(read(ANNOTATIONS_PATH));
  return parsed.tools ?? {};
}

/**
 * One row per exposed capability. An MCP operation and a playground tool
 * that share a handler are one row, keyed by the MCP `tool.op`; a
 * playground-only tool is keyed by its own name.
 */
export function audit() {
  checkFreshness();
  const mcp = enumerateMcp();
  const playground = enumeratePlayground();
  const annotations = loadAnnotations();

  const rows = [];
  const joined = new Set();
  for (const [key, { gate, handler }] of mcp) {
    const playgroundGate = playground.get(handler) ?? null;
    if (playgroundGate !== null) joined.add(handler);
    rows.push({ name: key, handler, mcp: gate, playground: playgroundGate });
  }
  for (const [name, gate] of playground) {
    if (joined.has(name)) continue;
    rows.push({ name, handler: name, mcp: null, playground: gate });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const names = rows.map((r) => r.name);
  const staleAnnotations = Object.keys(annotations).filter((n) => !names.includes(n));

  for (const row of rows) {
    const annotation = annotations[row.name];
    row.decision = annotation?.decision ?? 'unclassified';
    row.reason = annotation?.reason ?? '(no recorded decision — annotate in scripts/tool-parity.annotations.json)';
  }
  return { rows, staleAnnotations };
}

function cell(gate) {
  if (gate === null) return '✗';
  if (gate === 'always' || gate === 'always-on') return '✓';
  return `✓ ${gate}`;
}

export function renderMatrix(rows) {
  const counts = { gap: 0, deliberate: 0, unclassified: 0 };
  const lines = [
    '# Tool exposure parity matrix',
    '',
    `Generated by \`bun run tool:parity\` from ${rows.length} rows across the MCP bridge`,
    '(sandbox mode, one row per `tool.op`) and the playground agent registry.',
    'Classification source: scripts/tool-parity.annotations.json.',
    '',
    '| Row | Handler | MCP bridge | Playground agent | Classification |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    counts[r.decision] = (counts[r.decision] ?? 0) + 1;
    lines.push(
      `| \`${r.name}\` | \`${r.handler}\` | ${cell(r.mcp)} | ${cell(r.playground)} | **${r.decision}** — ${r.reason} |`,
    );
  }
  lines.push(
    '',
    `Totals: ${rows.length} rows — ${counts.gap} gap, ${counts.deliberate} deliberate, ${counts.unclassified} unclassified.`,
    '',
  );
  return { markdown: lines.join('\n'), counts };
}

// ─── CLI ──────────────────────────────────────────────────────────────

function main(argv) {
  const check = argv.includes('--check');
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : null;
  if (outIdx !== -1 && !outFile) {
    console.error('tool-parity: --out requires a file path');
    return 2;
  }

  const { rows, staleAnnotations } = audit();
  const { markdown, counts } = renderMatrix(rows);
  console.log(markdown);
  if (outFile) writeFileSync(outFile, markdown);

  let failed = false;
  if (staleAnnotations.length > 0) {
    console.error(
      `tool-parity: ${ANNOTATIONS_PATH} annotates rows no surface defines (stale or typo): ${staleAnnotations.join(', ')}`,
    );
    failed = true;
  }
  if (check && counts.unclassified > 0) {
    const unclassified = rows.filter((r) => r.decision === 'unclassified').map((r) => r.name);
    console.error(
      `tool-parity --check: ${counts.unclassified} row(s) have no recorded exposure decision:\n` +
        unclassified.map((n) => `  - ${n}`).join('\n') +
        `\nRecord each as "gap" or "deliberate" (with a reason) in ${ANNOTATIONS_PATH}.`,
    );
    failed = true;
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
