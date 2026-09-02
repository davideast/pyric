/**
 * Guards the tool-parity extractor (scripts/tool-parity.mjs) against
 * the real codebase: if a refactor moves a factory, renames a tool
 * file, or changes composition shape in a way the static extraction
 * can't follow, these assertions fail loudly instead of the parity
 * matrix silently shrinking.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  audit,
  enumerateMcp,
  enumeratePlayground,
  loadAnnotations,
  MCP_COMPOSITION_FILE,
  renderMatrix,
  REPO_ROOT,
} from './tool-parity.mjs';

describe('tool-parity extraction against the real codebase', () => {
  const mcp = enumerateMcp();
  const playground = enumeratePlayground();
  const { rows, staleAnnotations } = audit();

  test('the freshness guard reads the file that names every MCP factory', () => {
    // A guard pointed at a file that references no factory passes vacuously,
    // so the target must be the side map that wires each factory key.
    expect(MCP_COMPOSITION_FILE).toBe('packages/cli/src/bridge/server/tool-factories.ts');
    const source = readFileSync(join(REPO_ROOT, MCP_COMPOSITION_FILE), 'utf8');
    expect(source.match(/\bcreate[A-Z][A-Za-z]*Tool(?:s)?\b/g)?.length ?? 0).toBeGreaterThan(0);
  });

  test('finds a sane minimum of rows overall', () => {
    // A hard floor of 20 catches "extraction silently found almost nothing"
    // without churning on every add.
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });

  test('each surface finds a sane minimum', () => {
    expect(mcp.size).toBe(36); // the ratified operation count
    expect(playground.size).toBeGreaterThanOrEqual(15); // 27 at time of writing
  });

  test('known bridge operations are present (forwarded + in-process) with their handlers', () => {
    for (const [key, handler, gate] of [
      ['firestore_simulator.create', 'firestore_simulator_create', 'forwarded'],
      ['firestore_simulator.add', 'firestore_create_with_auto_id', 'forwarded'],
      ['firestore_data.get', 'firestore_get_document', 'forwarded'],
      ['firestore_data.batch_write', 'firestore_batch_write', 'forwarded'],
      ['sandbox.inspect', 'sandbox_inspect', 'forwarded'],
      ['database_rules.simulate', 'rtdb_simulate_access', 'forwarded'],
      ['database_data.crawl', 'rtdb_crawl_structure', 'forwarded'],
      ['firestore_rules.simulate', 'firestore_simulate_rules', 'in-process'],
      ['firestore_rules.lint', 'firestore_lint_rules', 'in-process'],
      ['firestore_rules.resolve', 'rules_resolve_modules', 'in-process'],
      ['storage_rules.resolve', 'rules_resolve_modules', 'in-process'],
      ['rules_stdlib.list', 'rules_stdlib_list', 'in-process'],
      ['pyric.can_i_use', 'pyric_can_i_use', 'in-process'],
    ]) {
      expect(mcp.get(key)).toEqual({ gate, handler });
    }
  });

  test('a shared handler joins the MCP operation and the playground tool into one row', () => {
    const shared = rows.find((r) => r.name === 'pyric.can_i_use');
    expect(shared.handler).toBe('pyric_can_i_use');
    expect(shared.mcp).toBe('in-process');
    expect(shared.playground).toBe('always-on');
    expect(rows.find((r) => r.name === 'pyric_can_i_use')).toBeUndefined();
    // The Firestore-only stdlib spellings stay playground-only.
    const firestoreOnly = rows.find((r) => r.name === 'firestore_rules_stdlib_get');
    expect(firestoreOnly.mcp).toBeNull();
    expect(firestoreOnly.playground).toBe('always-on');
  });

  test('known playground tools are present with the right gating', () => {
    for (const name of [
      'list_files',
      'write_file',
      'bash',
      'run_workspace_tests',
      'inspect_denial',
      'sandbox_discover_paths',
      'firestore_extract_indexes',
      'firestore_rules_stdlib_get',
      'inspect_auth_users',
      'seed_auth_users',
      'workspace_checkpoints',
      'workspace_git',
      'github_create_pull_request',
    ]) {
      expect(playground.get(name)).toStartWith('always-on');
    }
    for (const name of [
      'inspect_firestore_traffic',
      'simulate_firestore_write',
      'try_rules_edit',
      'generate_fixture_from_session',
      'debug_firestore_rules',
    ]) {
      expect(playground.get(name)).toStartWith('flag-gated');
    }
    // Registered in CORE_TOOLS despite living under diagnostics/.
    expect(playground.get('seed_firestore_data_as_admin')).toBe('always-on');
    expect(playground.get('build_game_rules')).toStartWith('skill-gated');
  });

  test('production-project inspection tools are absent from both surfaces', () => {
    for (const name of [
      'firestore_discover_paths',
      'firestore_find_collection_group',
      'firestore_inspect_rules',
    ]) {
      expect(mcp.has(name)).toBe(false);
      expect(playground.has(name)).toBe(false);
    }
  });

  test('the TOOL-SYSTEM.md gap rows are still gaps (playground-only)', () => {
    for (const name of [
      'inspect_firestore_traffic',
      'inspect_denial',
      'try_rules_edit',
      'generate_fixture_from_session',
    ]) {
      const row = rows.find((r) => r.name === name);
      expect(row).toBeDefined();
      expect(row.decision).toBe('gap');
      // If a gap tool ever lands on the bridge, this fails as a prompt
      // to flip its annotation to "deliberate"/exposed instead.
      expect(row.mcp).toBeNull();
      expect(row.playground).not.toBeNull();
    }
  });

  test('annotations only reference tools that exist on some surface', () => {
    expect(staleAnnotations).toEqual([]);
    const known = new Set(rows.map((r) => r.name));
    for (const name of Object.keys(loadAnnotations())) {
      expect(known.has(name)).toBe(true);
    }
  });

  test('matrix renders one row per capability and reports counts', () => {
    const { markdown, counts } = renderMatrix(rows);
    for (const r of rows) expect(markdown).toContain(`| \`${r.name}\` |`);
    expect(counts.gap + counts.deliberate + counts.unclassified).toBe(rows.length);
    expect(counts.gap).toBeGreaterThanOrEqual(4);
  });
});
