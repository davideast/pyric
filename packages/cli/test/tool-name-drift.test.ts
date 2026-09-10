import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BRIDGE_TOOL_NAMES, DEFAULT_MCP_TOOL_NAMES } from '../src/bridge/server/mcp-contract.js';

/**
 * Tool-shaped tokens that surface in skills or docs but do not name an MCP
 * tool. Each entry says what it actually is so it never gets mistaken for a
 * missing registration.
 */
const NON_TOOL_TOKENS = new Set<string>([
  'rules_version', // Firestore/RTDB rules file schema field, not a tool.
  'firestore_simulator_', // Prose stem ("firestore_simulator_*"), not a literal tool name.
  'pyric_firestore', // Dart/Flutter package name, not a tool.
]);

const SCAN_ROOTS = ['pyric-plugin', '.agents/skills', 'packages/site-docs/src/content'];

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist']);

const TOOL_TOKEN_PATTERN = /\b(firestore|rtdb|rules|sandbox|pyric|storage|auth|database)_[a-z][a-z0-9_]*\b/g;

const repoRoot = resolve(import.meta.dir, '../../..');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else if (stats.isFile()) {
      out.push(full);
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(repoRoot, root);
    try {
      walk(abs, files);
    } catch {
      // Root does not exist in this tree; nothing to scan.
    }
  }
  return files;
}

interface Reference {
  file: string;
  name: string;
}

function collectReferences(): Reference[] {
  const references: Reference[] = [];
  for (const file of collectFiles()) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // Skip binary files (null-byte heuristic).
    const relFile = file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
    const matches = text.matchAll(TOOL_TOKEN_PATTERN);
    for (const match of matches) {
      const name = match[0];
      if (NON_TOOL_TOKENS.has(name)) continue;
      references.push({ file: relFile, name });
    }
  }
  return references;
}

describe('tool name drift', () => {
  // A reference is registered if it names a tool the in-process product surface
  // serves (`pyric mcp`, `DEFAULT_MCP_TOOL_NAMES`) or a tool the served bridge
  // still advertises to its browser sandbox peer (`BRIDGE_TOOL_NAMES`, the
  // transport surface `tool-family-records/` authors). Both are real,
  // registered names in this tree; only a name in neither is drift.
  const registered = new Set<string>([...DEFAULT_MCP_TOOL_NAMES, ...BRIDGE_TOOL_NAMES]);
  const references = collectReferences();

  test('every referenced name is registered', () => {
    const offenders = references.filter((ref) => !registered.has(ref.name));
    const message = offenders.map((ref) => `${ref.file}: ${ref.name}`).join('\n');
    expect(offenders, message).toEqual([]);
  });
});
