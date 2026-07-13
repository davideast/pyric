#!/usr/bin/env bun
/**
 * Tool-registry parity audit (TOOL-SYSTEM.md, "Exposure matrix").
 *
 * Enumerates the three tool surfaces by static extraction and emits the
 * exposure matrix mechanically, so drift is detected rather than
 * remembered:
 *
 *   1. MCP bridge (sandbox mode) — what
 *      packages/pyric-tools/src/bridge/server/tool-metadata.ts composes:
 *      forwarded sandbox tools + in-process rules tools. (Prod-mode
 *      bridges take `prodTools` from composeMcpRegistry — that IS the
 *      registry surface below, so it is not double-counted here.)
 *   2. Playground agent — what
 *      packages/playground/src/lib/tools/index.ts's buildToolRegistry()
 *      registers: core / auth / git / checkpoints always-on, diagnostics
 *      flag-gated, skill tools skill-gated. Profile filtering
 *      (AUTHORING_TOOL_NAMES) is parsed from source, not restated here.
 *   3. @pyric/cli registry — the maximal composeMcpRegistry() surface
 *      (profile 'full', scope + adminDeps + rtdbHost all supplied), with
 *      per-tool gates recorded.
 *
 * Extraction is static: tool `name: '...'` literals are read out of the
 * factory function bodies that each composition file references. The
 * per-surface manifests below MIRROR the composition files; a freshness
 * guard re-reads those files and fails if they reference a factory the
 * manifest does not cover, so additions break the audit loudly instead
 * of silently vanishing from the matrix.
 *
 * Classification comes from scripts/tool-parity.annotations.json —
 * every tool's exposure decision must be recorded there ("gap" or
 * "deliberate"). Unannotated tools report as "unclassified", and
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
const TOOLS = 'packages/pyric-tools/src';
const PLAY = 'packages/playground/src/lib';

/** MCP bridge, sandbox mode — mirrors bridge/server/tool-metadata.ts. */
const MCP_CONTRIBUTIONS = [
  { file: `${PYRIC}/rules/simulator-tools-impl.ts`, factory: 'createFirestoreSimulatorTools', gate: 'forwarded' },
  { file: `${PYRIC}/firestore/tools.ts`, factory: 'createFirestoreDataTools', gate: 'forwarded' },
  { file: `${PYRIC}/firestore/tools.ts`, factory: 'createFirestoreInspectTools', gate: 'forwarded' },
  { file: `${TOOLS}/rtdb/inspection.ts`, factory: 'createRtdbInspectionTools', gate: 'forwarded' },
  { file: `${TOOLS}/assurance/tools.ts`, factory: 'createAssuranceTools', gate: 'forwarded, local-only' },
  // getRulesToolHandlers → createFirestoreRulesTools, which spreads the
  // stdlib factory and adds firestore_test_rules only when a scope is
  // supplied (the default sandbox bridge supplies none).
  {
    file: `${PYRIC}/rules/tools.ts`,
    factory: 'createFirestoreRulesTools',
    gate: 'in-process',
    gates: { firestore_test_rules: 'in-process, scope-gated' },
  },
  { file: `${PYRIC}/rules/stdlib-tools.ts`, factory: 'createFirestoreRulesStdlibTools', gate: 'in-process' },
];

/** @pyric/cli registry — mirrors registry/compose.ts (maximal: profile
 *  'full' with scope + adminDeps + rtdbHost). */
const REGISTRY_CONTRIBUTIONS = [
  { file: `${PYRIC}/rules/tools.ts`, factory: 'createFirestoreRulesTools', gate: 'always' },
  { file: `${PYRIC}/rules/stdlib-tools.ts`, factory: 'createFirestoreRulesStdlibTools', gate: 'always' },
  { file: `${TOOLS}/auth/tools.ts`, factory: 'createAuthAdminTools', gate: 'always' },
  { file: `${TOOLS}/verify/tools.ts`, factory: 'createVerifyTools', gate: 'always' },
  { file: `${TOOLS}/assurance/tools.ts`, factory: 'createAssuranceTools', gate: 'local-only' },
  { file: `${TOOLS}/rtdb/rules-generation-tool.ts`, factory: 'createRtdbRulesGenerationTools', gate: 'local-only' },
  { file: `${PYRIC}/rules/indexes/extractTool.ts`, factory: 'createFirestoreExtractTool', gate: 'full profile' },
  { file: `${PYRIC}/firestore/tools.ts`, factory: 'createFirestoreDataTools', gate: 'adminDeps' },
  { file: `${TOOLS}/discover/tools.ts`, factory: 'createFirestoreDiscoverTools', gate: 'adminDeps' },
  { file: `${PYRIC}/database/tools.ts`, factory: 'createRtdbRulesTools', gate: 'rtdbHost' },
  { file: `${PYRIC}/database/tools.ts`, factory: 'createRtdbDataTools', gate: 'rtdbHost' },
];

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
  [`${PLAY}/tools/core/firestoreRulesStdlib.ts`]: {
    file: `${PYRIC}/rules/stdlib-tools.ts`,
    factory: 'createFirestoreRulesStdlibTools',
    pick: ['firestore_rules_stdlib_list', 'firestore_rules_stdlib_get'],
    gate: 'always-on',
  },
  [`${PLAY}/tools/diagnostics/firestore-rules-inspect.ts`]: {
    file: `${PYRIC}/rules/inspect/tools.ts`,
    factory: 'createFirestoreInspectTool',
    gate: 'flag-gated + requires sign-in/project',
  },
  [`${PLAY}/tools/diagnostics/firestore-discover.ts`]: {
    file: `${TOOLS}/discover/tools.ts`,
    factory: 'createFirestoreDiscoverTools',
    gate: 'flag-gated + requires sign-in/project',
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
  const missing = [...referenced].filter((f) => !covered.has(f));
  if (missing.length > 0) {
    throw new Error(
      `tool-parity: ${rel} references factories not covered by the audit manifest: ${missing.join(', ')}. ` +
        'Add them to scripts/tool-parity.mjs so the new tools appear in the parity matrix.',
    );
  }
}

function checkFreshness() {
  assertCovered(
    `${TOOLS}/bridge/server/tool-metadata.ts`,
    new Set(MCP_CONTRIBUTIONS.map((c) => c.factory)),
  );
  assertCovered(
    `${TOOLS}/registry/compose.ts`,
    new Set([
      ...REGISTRY_CONTRIBUTIONS.map((c) => c.factory),
      // Local wrappers in compose.ts around covered factories.
      'createFirestoreAdminDataTools',
      'createFirestoreAdminDiscoverTools',
    ]),
    { ignore: ['createToolRegistry'] },
  );
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

export function enumerateMcp() {
  const surface = new Map();
  for (const c of MCP_CONTRIBUTIONS) {
    for (const name of factoryNames(c.file, c.factory)) {
      addTool(surface, name, c.gates?.[name] ?? c.gate);
    }
  }
  return surface;
}

export function enumerateRegistry() {
  const surface = new Map();
  for (const c of REGISTRY_CONTRIBUTIONS) {
    for (const name of factoryNames(c.file, c.factory)) {
      addTool(surface, name, c.gate);
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

export function audit() {
  checkFreshness();
  const mcp = enumerateMcp();
  const playground = enumeratePlayground();
  const registry = enumerateRegistry();
  const annotations = loadAnnotations();

  const names = [...new Set([...mcp.keys(), ...playground.keys(), ...registry.keys()])].sort();
  const staleAnnotations = Object.keys(annotations).filter((n) => !names.includes(n));

  const rows = names.map((name) => {
    const annotation = annotations[name];
    return {
      name,
      mcp: mcp.get(name) ?? null,
      playground: playground.get(name) ?? null,
      registry: registry.get(name) ?? null,
      decision: annotation?.decision ?? 'unclassified',
      reason: annotation?.reason ?? '(no recorded decision — annotate in scripts/tool-parity.annotations.json)',
    };
  });
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
    `Generated by \`bun run tool:parity\` from ${rows.length} tools across the MCP bridge`,
    '(sandbox mode), the playground agent registry, and composeMcpRegistry (maximal',
    "'full' profile). Classification source: scripts/tool-parity.annotations.json.",
    '',
    '| Tool | MCP bridge | Playground agent | @pyric/cli registry | Classification |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    counts[r.decision] = (counts[r.decision] ?? 0) + 1;
    lines.push(
      `| \`${r.name}\` | ${cell(r.mcp)} | ${cell(r.playground)} | ${cell(r.registry)} | **${r.decision}** — ${r.reason} |`,
    );
  }
  lines.push(
    '',
    `Totals: ${rows.length} tools — ${counts.gap} gap, ${counts.deliberate} deliberate, ${counts.unclassified} unclassified.`,
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
      `tool-parity: ${ANNOTATIONS_PATH} annotates tools no surface defines (stale or typo): ${staleAnnotations.join(', ')}`,
    );
    failed = true;
  }
  if (check && counts.unclassified > 0) {
    const unclassified = rows.filter((r) => r.decision === 'unclassified').map((r) => r.name);
    console.error(
      `tool-parity --check: ${counts.unclassified} tool(s) have no recorded exposure decision:\n` +
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
