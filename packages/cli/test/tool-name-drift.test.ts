import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_MCP_TOOL_OPS } from '../src/bridge/server/mcp-contract.js';

/**
 * Tool-shaped tokens that surface in skills or docs but do not name an MCP
 * tool or operation. Each entry says what it actually is so it never gets
 * mistaken for a missing registration.
 */
const NON_TOOL_TOKENS = new Set<string>([
  'rules_version', // Firestore/RTDB rules file schema field, not a tool.
  'auth.token', // Rules expression (`request.auth.token`, RTDB `auth.token`).
  'auth.uid', // Rules expression (`request.auth.uid`, RTDB `auth.uid`).
  'database.rules', // `database.rules.json`, the RTDB rules artifact.
  'firestore.indexes', // `firestore.indexes.json`, the index artifact.
  'firestore.modules', // `firestore.modules.rules`, the authored source.
  'firestore.rules', // The Firestore rules artifact.
  'storage.modules', // `storage.modules.rules`, the authored source.
  'storage.rules', // The Cloud Storage rules artifact.
]);

/**
 * Names that skills or docs reference but the registry does not expose
 * today, written in the ratified grammar: a tool name, or `tool.op` for an
 * operation of a registered tool. Each entry records where its handler
 * lives, or that no handler exists at all. This list is self-cleaning:
 * assertion 2 fails the moment a lane registers one of these, forcing its
 * removal instead of letting the list go stale.
 */
const KNOWN_UNREGISTERED: Record<string, string> = {
  'auth.configure_provider': 'no handler exists',
  'auth.get_config': 'no handler exists',
  'auth.manage_domains': 'no handler exists',
  'database_data.get': 'no handler exists',
  'database_data.push': 'no handler exists',
  'database_data.set': 'no handler exists',
  'database_data.update': 'no handler exists',
  'database_data.validated_write': 'no handler exists',
  'database_rules.build_expression': 'no handler exists',
  'database_rules.deploy': 'no handler exists',
  'database_rules.get': 'no handler exists',
  'firestore_rules.get': 'no handler exists',
  'firestore_rules.test': 'handler in packages/pyric/src/rules/tools.ts',
  'pyric.verify_cases': 'handler in packages/cli/src/verify/tools.ts',
  firestore_discover_paths: 'handler in packages/cli/src/discover/tools.ts',
  firestore_extract_indexes:
    'handler in packages/pyric/src/rules/indexes/extractTool.ts (also a Playground-only wrapper of the same name)',
  firestore_find_collection_group: 'handler in packages/cli/src/discover/tools.ts',
};

const SCAN_ROOTS = ['pyric-plugin', '.agents/skills', 'packages/site-docs/src/content'];

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist']);

/**
 * A tool name in the ratified grammar, optionally followed by `.op`. A tool
 * name is a service word plus at most one artifact word; a bare service word
 * (`sandbox`, `pyric`) counts only in the dotted form, since the word alone
 * is ordinary prose. A token preceded by `.` is a member access
 * (`request.auth.uid`), not a tool.
 */
const SERVICE_WORDS = 'firestore|database|storage|auth|rules|sandbox|pyric';
const TOOL_TOKEN_PATTERN = new RegExp(
  `(?<![.\\w])(?:(${SERVICE_WORDS})_([a-z][a-z0-9_]*)|(${SERVICE_WORDS}))(?:\\.([a-z][a-z0-9_]*))?\\b`,
  'g',
);

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
  tool: string;
  op?: string;
}

function referenceKey(ref: Pick<Reference, 'tool' | 'op'>): string {
  return ref.op ? `${ref.tool}.${ref.op}` : ref.tool;
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
    for (const match of text.matchAll(TOOL_TOKEN_PATTERN)) {
      const [, service, artifact, bareService, op] = match;
      if (bareService && !op) continue; // A service word alone is prose.
      const tool = bareService ?? `${service}_${artifact}`;
      if (NON_TOOL_TOKENS.has(tool) || NON_TOOL_TOKENS.has(referenceKey({ tool, op }))) continue;
      references.push({ file: relFile, tool, ...(op ? { op } : {}) });
    }
  }
  return references;
}

function isRegistered(ref: Pick<Reference, 'tool' | 'op'>): boolean {
  const ops = DEFAULT_MCP_TOOL_OPS[ref.tool];
  if (!ops) return false;
  return ref.op === undefined || ops.includes(ref.op);
}

describe('tool name drift', () => {
  const references = collectReferences();

  test('every referenced tool and op is registered or a documented gap', () => {
    const offenders = references.filter(
      (ref) => !isRegistered(ref) && !(referenceKey(ref) in KNOWN_UNREGISTERED),
    );
    const message = offenders.map((ref) => `${ref.file}: ${referenceKey(ref)}`).join('\n');
    expect(offenders, message).toEqual([]);
  });

  test('KNOWN_UNREGISTERED stays self-cleaning: no entry is actually registered', () => {
    const stillUnregistered = Object.keys(KNOWN_UNREGISTERED).filter((key) => {
      const [tool, op] = key.split('.') as [string, string | undefined];
      return !isRegistered({ tool, ...(op ? { op } : {}) });
    });
    expect(stillUnregistered).toEqual(Object.keys(KNOWN_UNREGISTERED));
  });

  test('every KNOWN_UNREGISTERED entry appears in at least one scanned file', () => {
    const referenced = new Set(references.map(referenceKey));
    const dead = Object.keys(KNOWN_UNREGISTERED).filter((key) => !referenced.has(key));
    expect(dead).toEqual([]);
  });

  test('the token pattern reads both a bare tool and a tool with an op', () => {
    const sample =
      'Call `firestore_data.get`, then `sandbox.inspect`; the sandbox and pyric words alone are prose, as is rules_version and request.auth.uid.';
    const found = [...sample.matchAll(TOOL_TOKEN_PATTERN)].map((match) => match[0]);
    expect(found).toEqual(['firestore_data.get', 'sandbox.inspect', 'sandbox', 'pyric', 'rules_version']);
  });
});
