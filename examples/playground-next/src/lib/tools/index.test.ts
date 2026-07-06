import { describe, expect, test } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';
import { filterToolsForProfile } from './index';

function tool(name: string): ToolHandler {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true, summary: name }) } as ToolHandler;
}

const ALL = [
  'list_files',
  'search_file',
  'read_file',
  'edit_file',
  'write_file',
  'delete_file',
  'run_workspace_tests',
  'firestore_rules_stdlib_list',
  'firestore_rules_stdlib_get',
  'bash',
  'simulate_firestore_write',
  'seed_firestore_data_as_admin',
  'debug_firestore_rules',
].map(tool);

describe('filterToolsForProfile', () => {
  test('draft profile is bounded and mutation-free', () => {
    const names = filterToolsForProfile(ALL, 'draft').map((t) => t.name);
    expect(names).toEqual([
      'list_files',
      'search_file',
      'read_file',
      'simulate_firestore_write',
      'seed_firestore_data_as_admin',
    ]);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
  });

  test('authoring profile includes granular file tools but excludes debug diagnostics', () => {
    const names = filterToolsForProfile(ALL, 'authoring').map((t) => t.name);
    expect(names).toContain('edit_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_workspace_tests');
    expect(names).toContain('bash');
    expect(names).not.toContain('debug_firestore_rules');
  });

  test('diagnostic profile preserves the full registered list', () => {
    expect(filterToolsForProfile(ALL, 'diagnostic').map((t) => t.name)).toEqual(ALL.map((t) => t.name));
  });
});
