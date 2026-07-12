/**
 * Guards the tool-parity extractor (scripts/tool-parity.mjs) against
 * the real codebase: if a refactor moves a factory, renames a tool
 * file, or changes composition shape in a way the static extraction
 * can't follow, these assertions fail loudly instead of the parity
 * matrix silently shrinking.
 */
import { describe, expect, test } from 'bun:test';
import {
  audit,
  enumerateMcp,
  enumeratePlayground,
  enumerateRegistry,
  loadAnnotations,
  renderMatrix,
} from './tool-parity.mjs';

describe('tool-parity extraction against the real codebase', () => {
  const mcp = enumerateMcp();
  const playground = enumeratePlayground();
  const registry = enumerateRegistry();
  const { rows, staleAnnotations } = audit();

  test('finds a sane minimum of tools overall', () => {
    // 78 at time of writing; a hard floor of 20 catches "extraction
    // silently found almost nothing" without churning on every add.
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });

  test('each surface finds a sane minimum', () => {
    expect(mcp.size).toBeGreaterThanOrEqual(15); // 24 at time of writing
    expect(playground.size).toBeGreaterThanOrEqual(15); // 27 at time of writing
    expect(registry.size).toBeGreaterThanOrEqual(20); // 41 at time of writing
  });

  test('known bridge tools are present (forwarded + in-process)', () => {
    for (const name of [
      'firestore_simulator_create',
      'firestore_simulator_execute',
      'firestore_get_document',
      'firestore_batch_write',
      'sandbox_inspect',
      'firestore_simulate_rules',
      'firestore_lint_rules',
      'firestore_rules_stdlib_list',
      'firestore_test_rules',
      'firebase_assurance_attach',
      'firebase_assurance_verify',
    ]) {
      expect(mcp.has(name)).toBe(true);
    }
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
      'firestore_discover_paths',
      'firestore_inspect_rules',
    ]) {
      expect(playground.get(name)).toStartWith('flag-gated');
    }
    // Registered in CORE_TOOLS despite living under diagnostics/.
    expect(playground.get('seed_firestore_data_as_admin')).toBe('always-on');
    expect(playground.get('build_game_rules')).toStartWith('skill-gated');
  });

  test('known registry tools are present', () => {
    for (const name of [
      'firestore_deploy_rules',
      'firestore_get_rules',
      'firestore_deploy_indexes',
      'hosting_deploy',
      'functions_deploy',
      'auth_get_config',
      'pyric_verify_fixture',
      'firestore_extract_indexes',
      'firestore_discover_paths',
      'rtdb_simulate_access',
      'rtdb_validated_write',
      'firebase_assurance_start',
      'firebase_assurance_export',
    ]) {
      expect(registry.has(name)).toBe(true);
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

  test('matrix renders one row per tool and reports counts', () => {
    const { markdown, counts } = renderMatrix(rows);
    for (const r of rows) expect(markdown).toContain(`| \`${r.name}\` |`);
    expect(counts.gap + counts.deliberate + counts.unclassified).toBe(rows.length);
    expect(counts.gap).toBeGreaterThanOrEqual(4);
  });
});
