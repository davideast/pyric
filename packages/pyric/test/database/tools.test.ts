import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createRtdbAdminTools,
  createRtdbDataTools,
  createRtdbRulesTools,
} from '../../src/database/tools.js';
import type { RtdbHost } from '../../src/database/host.js';
import { UNSUPPORTED_DATA_TRANSPORT } from './fixtures.js';

const VALID_RULES = { rules: { '.read': 'auth !== null', '.write': 'false' } };

function makeHost(): RtdbHost {
  return {
    projectId: 'test-project',
    databaseUrl: 'https://test-default-rtdb.firebaseio.com',
    resolveAdminToken: async () => 'mock-admin-token',
    resolveUserToken: async () => 'mock-user-token',
    data: UNSUPPORTED_DATA_TRANSPORT,
  };
}

const realFetch = global.fetch;
beforeEach(() => {
  (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes('/.settings/rules.json')) {
      return new Response(JSON.stringify(VALID_RULES), { status: 200 });
    }
    return new Response('null', { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { global.fetch = realFetch; });

describe('createRtdbAdminTools', () => {
  test('rules and data factories split the legacy tool set', () => {
    const host = makeHost();
    expect(createRtdbRulesTools({ host }).map((t) => t.name).sort()).toEqual([
      'rtdb_build_expression',
      'rtdb_deploy_rules',
      'rtdb_get_rules',
      'rtdb_simulate_access',
    ]);
    expect(createRtdbDataTools({ host }).map((t) => t.name).sort()).toEqual([
      'rtdb_crawl_structure',
      'rtdb_delete',
      'rtdb_get',
      'rtdb_push',
      'rtdb_set',
      'rtdb_update',
      'rtdb_validated_write',
    ]);
  });

  test('returns 11 tools', () => {
    const tools = createRtdbAdminTools({ host: makeHost() });
    expect(tools).toHaveLength(11);
  });

  test('all tools have the ToolHandler shape', () => {
    const tools = createRtdbAdminTools({ host: makeHost() });
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe('function');
      expect(tool.parameters).toBeDefined();
    }
  });

  test('tool names match the legacy rtdb_* set', () => {
    const tools = createRtdbAdminTools({ host: makeHost() });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'rtdb_build_expression',
      'rtdb_crawl_structure',
      'rtdb_delete',
      'rtdb_deploy_rules',
      'rtdb_get',
      'rtdb_get_rules',
      'rtdb_push',
      'rtdb_set',
      'rtdb_simulate_access',
      'rtdb_update',
      'rtdb_validated_write',
    ]);
  });

  test('rtdb_get_rules executes via the handler', async () => {
    const tools = createRtdbAdminTools({ host: makeHost() });
    const tool = tools.find((t) => t.name === 'rtdb_get_rules')!;
    const result = await tool.execute({}, { signal: new AbortController().signal });
    expect(result.ok).toBe(true);
  });
});
