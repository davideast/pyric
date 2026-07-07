/**
 * Claude lane MCP bridge — server-side unit tests. No subprocess, no
 * dev server: JSON-RPC requests are driven straight through
 * `handleMcpPost` (the exact surface `claude -p`'s MCP client POSTs
 * to) and the registry/dispatch layer is exercised with both fake and
 * REAL workspace tool handlers (headless VFS, same proof as
 * `src/lib/vfs/file-tools-headless.test.ts`).
 */
import { describe, test, expect, beforeAll } from 'bun:test';

// The tool chain reads window.localStorage at import time — polyfill
// BEFORE the module under test dynamically imports it.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
  };
}

import {
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  handleMcpPost,
  loadWorkspaceTools,
  mcpAllowedTools,
  mcpHealth,
  replaceServerWorkspace,
  snapshotServerWorkspace,
} from './claude-mcp';

// ── JSON-RPC plumbing (what claude's MCP client sends) ───────────────

let nextId = 1;

function rpcRequest(method: string, params: unknown): Request {
  return new Request('http://localhost/api/claude-mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The streamable-HTTP transport requires both accept types.
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
}

async function rpc(method: string, params: unknown): Promise<any> {
  const res = await handleMcpPost(rpcRequest(method, params));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.jsonrpc).toBe('2.0');
  return body.result;
}

const INIT_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'fake-claude-client', version: '0.0.0' },
};

describe('MCP endpoint protocol (stateless per-request)', () => {
  test('initialize handshake answers with the playground server identity', async () => {
    const result = await rpc('initialize', INIT_PARAMS);
    expect(result.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(result.capabilities.tools).toBeDefined();
  });

  test('tools/list serves every advertised tool with its JSON schema VERBATIM', async () => {
    const result = await rpc('tools/list', {});
    const byName = new Map((result.tools as any[]).map((t) => [t.name, t]));
    for (const name of MCP_TOOL_NAMES) {
      expect(byName.has(name)).toBe(true);
    }
    // Schema fidelity: the simulator's enum survives (no zod round-trip).
    const sim = byName.get('simulate_firestore_write');
    expect(sim.inputSchema.properties.method.enum).toEqual([
      'get',
      'list',
      'create',
      'update',
      'delete',
    ]);
  });

  test('tools/call write_file then read_file round-trips through the wire', async () => {
    const write = await rpc('tools/call', {
      name: 'write_file',
      arguments: { path: '/workspace/hello.txt', content: 'hi' },
    });
    expect(write.isError).toBeFalsy();
    const writeBody = JSON.parse(write.content[0].text);
    expect(writeBody.ok).toBe(true);

    const read = await rpc('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/hello.txt' },
    });
    const readBody = JSON.parse(read.content[0].text);
    expect(readBody.ok).toBe(true);
    expect(readBody.data.content).toBe('hi');
  });

  test('tool results are COMPACT: single line, contract fields only', async () => {
    const read = await rpc('tools/call', {
      name: 'list_files',
      arguments: {},
    });
    const text: string = read.content[0].text;
    expect(text).not.toContain('\n'); // no pretty-printing — tokens cost money
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(['data', 'ok', 'summary']);
  });

  test('unknown tool name → isError result, not a protocol crash', async () => {
    const result = await rpc('tools/call', { name: 'rm_rf_slash', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rm_rf_slash');
  });

  test('rules stdlib list + get dispatch over the wire (delegated-lane trigger tools)', async () => {
    const list = await rpc('tools/call', { name: 'firestore_rules_stdlib_list', arguments: {} });
    expect(list.isError).toBeFalsy();
    const listBody = JSON.parse(list.content[0].text);
    expect(listBody.ok).toBe(true);
    expect(listBody.data.modules.length).toBeGreaterThan(10);

    const key = listBody.data.modules[0].key;
    const get = await rpc('tools/call', {
      name: 'firestore_rules_stdlib_get',
      arguments: { key },
    });
    const getBody = JSON.parse(get.content[0].text);
    expect(getBody.ok).toBe(true);
    expect(getBody.data.module.key).toBe(key);
  });

  test('firestore_lint_rules catches a parse error through the bridge', async () => {
    const lint = await rpc('tools/call', {
      name: 'firestore_lint_rules',
      arguments: { source: 'rules_version = ; this does not parse' },
    });
    expect(lint.isError).toBe(true);
    const body = JSON.parse(lint.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.summary).toContain('Parse failed');
  });

  test('bash runs in the jailed workspace shell (man builtin reachable)', async () => {
    const res = await rpc('tools/call', { name: 'bash', arguments: { command: 'man -k' } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.data.stdout).toContain('rules');
  });

  test('a throwing handler maps to isError JSON, not a protocol crash', async () => {
    // read_file on a missing path rejects inside the REAL handler —
    // the dispatch layer must convert that into a compact isError
    // result so claude sees a tool failure it can react to.
    const read = await rpc('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/definitely-missing.txt' },
    });
    expect(read.isError).toBe(true);
    const body = JSON.parse(read.content[0].text);
    expect(body.ok).toBe(false);
  });
});

describe('tool registry composition', () => {
  test('loadWorkspaceTools matches MCP_TOOL_NAMES exactly (no drift)', async () => {
    const handlers = await loadWorkspaceTools();
    expect(handlers.map((h) => h.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  test('mcpAllowedTools produces claude --allowedTools entries', () => {
    const allowed = mcpAllowedTools();
    expect(allowed).toContain('mcp__playground__write_file');
    expect(allowed).toContain('mcp__playground__run_workspace_tests');
    expect(allowed).toHaveLength(MCP_TOOL_NAMES.length);
  });

  test('mcpHealth advertises the tool list for the lane preflight', () => {
    const health = mcpHealth();
    expect(health.ok).toBe(true);
    expect(health.tools).toEqual([...MCP_TOOL_NAMES]);
  });
});

describe('server workspace snapshot (browser push/pull)', () => {
  beforeAll(async () => {
    await loadWorkspaceTools();
  });

  test('replace seeds files and snapshot reads them back; stale files are dropped', async () => {
    await replaceServerWorkspace({
      files: [
        { path: '/workspace/firestore.rules', content: "rules_version = '2';" },
        { path: '/workspace/src/App.tsx', content: 'export default () => null;' },
      ],
    });
    let snap = await snapshotServerWorkspace();
    const paths = snap.files.map((f) => f.path).sort();
    expect(paths).toContain('/workspace/firestore.rules');
    expect(paths).toContain('/workspace/src/App.tsx');

    // Second replace WITHOUT App.tsx — the stale file must disappear.
    await replaceServerWorkspace({
      files: [{ path: '/workspace/firestore.rules', content: "rules_version = '2';" }],
    });
    snap = await snapshotServerWorkspace();
    expect(snap.files.map((f) => f.path)).not.toContain('/workspace/src/App.tsx');
  });

  test('replace ignores paths outside /workspace/', async () => {
    await replaceServerWorkspace({
      files: [{ path: '/etc/passwd', content: 'nope' }],
    });
    const snap = await snapshotServerWorkspace();
    expect(snap.files.map((f) => f.path)).not.toContain('/etc/passwd');
  });
});
