import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_MCP_TOOL_NAMES } from '../src/bridge/server/mcp-contract.js';

/**
 * Tool-shaped tokens that surface in skills or docs but do not name an MCP
 * tool. Each entry says what it actually is so it never gets mistaken for a
 * missing registration.
 */
const NON_TOOL_TOKENS = new Set<string>([
  'rules_version', // Firestore/RTDB rules file schema field, not a tool.
  'firestore_simulator_', // Prose stem ("firestore_simulator_*"), not a literal tool name.
]);

/**
 * Names that skills or docs reference but the registry does not expose
 * today. Each entry records where its handler lives, or that no handler
 * exists at all. This list is self-cleaning: assertion 2 fails the moment a
 * lane registers one of these, forcing its removal instead of letting the
 * list go stale.
 */
const KNOWN_UNREGISTERED: Record<string, string> = {
  auth_configure_provider: 'no handler exists',
  auth_get_config: 'no handler exists',
  auth_manage_domains: 'no handler exists',
  firestore_discover_paths: 'handler in packages/cli/src/discover/tools.ts',
  firestore_extract_indexes:
    'handler in packages/pyric/src/rules/indexes/extractTool.ts (also a Playground-only wrapper of the same name)',
  firestore_find_collection_group: 'handler in packages/cli/src/discover/tools.ts',
  firestore_get_rules: 'no handler exists',
  firestore_test_rules: 'handler in packages/pyric/src/rules/tools.ts',
  pyric_derive_rules_test_cases: 'handler in packages/cli/src/verify/tools.ts',
  pyric_sandbox_inspect: 'no handler exists',
  rtdb_build_expression: 'no handler exists',
  rtdb_deploy_rules: 'no handler exists',
  rtdb_get: 'no handler exists',
  rtdb_get_rules: 'no handler exists',
  rtdb_push: 'no handler exists',
  rtdb_set: 'no handler exists',
  rtdb_update: 'no handler exists',
  rtdb_validated_write: 'no handler exists',
};

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
  const registered = new Set<string>(DEFAULT_MCP_TOOL_NAMES);
  const references = collectReferences();

  test('every referenced name is registered or a documented gap', () => {
    const offenders = references.filter(
      (ref) => !registered.has(ref.name) && !(ref.name in KNOWN_UNREGISTERED),
    );
    const message = offenders
      .map((ref) => `${ref.file}: ${ref.name}`)
      .join('\n');
    expect(offenders, message).toEqual([]);
  });

  test('KNOWN_UNREGISTERED stays self-cleaning: no entry is actually registered', () => {
    const stillUnregistered = Object.keys(KNOWN_UNREGISTERED).filter((name) => !registered.has(name));
    expect(stillUnregistered).toEqual(Object.keys(KNOWN_UNREGISTERED));
  });

  test('every KNOWN_UNREGISTERED entry appears in at least one scanned file', () => {
    const referenced = new Set(references.map((ref) => ref.name));
    const dead = Object.keys(KNOWN_UNREGISTERED).filter((name) => !referenced.has(name));
    expect(dead).toEqual([]);
  });
});
