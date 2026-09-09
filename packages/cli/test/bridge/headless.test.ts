/**
 * Headless MCP server session (`src/bridge/server/headless.ts`).
 *
 * These drive a real MCP client against a real headless session over a linked
 * in-memory transport, which is the only way to see the three behaviours that
 * matter to the tool-surface evaluation: an event per call in the log the
 * environment names, a call the SDK rejects before dispatch still logged, and a
 * snapshot on disk the moment the session closes rather than 750ms later.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  runHeadlessMcp,
  buildHeadlessMcpServer,
  createHeadlessEventWriter,
  HEADLESS_STATE_RELATIVE,
} from '../../src/bridge/server/headless.js';
import { DEFAULT_MCP_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';

interface LoggedEvent {
  tool: string;
  args: Record<string, unknown>;
  result: { ok: boolean; summary: string };
  durationMs: number;
  operation: string | null;
  action: string | null;
  schemaRejected: boolean;
  isError: boolean;
  run: Record<string, unknown>;
}

function evalEnv(logPath: string): NodeJS.ProcessEnv {
  return {
    PYRIC_EVAL_LOG: logPath,
    PYRIC_EVAL_RUN_ID: 'run-1',
    PYRIC_EVAL_TASK_ID: 'task-1',
    PYRIC_EVAL_VARIANT: 'verb-prefixed',
    PYRIC_EVAL_CLI: 'claude',
    PYRIC_EVAL_MODEL: 'fable-5-1',
    PYRIC_EVAL_EFFORT: 'high',
    PYRIC_EVAL_CONDITION: 'mcp-only',
    PYRIC_EVAL_SEED: '3',
  };
}

function readEvents(path: string): LoggedEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LoggedEvent);
}

/** Start a headless session on an in-memory pair and return a connected client. */
async function openSession(cwd: string, env: NodeJS.ProcessEnv) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const exit = runHeadlessMcp(cwd, { env, transport: serverTransport });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const close = async (): Promise<number> => {
    await client.close();
    return await exit;
  };
  return { client, close };
}

describe('headless MCP session', () => {
  it('records one event per call in PYRIC_EVAL_LOG and writes no project audit log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-headless-eval-'));
    const home = mkdtempSync(join(tmpdir(), 'pyric-headless-home-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const logPath = join(dir, 'events.ndjson');
      const session = await openSession(dir, evalEnv(logPath));

      const created = await session.client.callTool({
        name: 'firestore_create_document',
        arguments: { path: 'rooms/r1/msgs/m1', data: { body: 'hi' } },
      });
      expect(created.isError).toBeFalsy();
      await session.close();

      const events = readEvents(logPath);
      expect(events.length).toBe(1);
      const [event] = events as [LoggedEvent];
      expect(event.tool).toBe('firestore_create_document');
      expect(event.args).toEqual({ path: 'rooms/r1/msgs/m1', data: { body: 'hi' } });
      expect(event.result.ok).toBe(true);
      expect(event.isError).toBe(false);
      expect(event.schemaRejected).toBe(false);
      expect(event.operation).toBe(null);
      expect(event.action).toBe(null);
      expect(typeof event.durationMs).toBe('number');
      expect(event.run).toEqual({
        runId: 'run-1',
        taskId: 'task-1',
        variant: 'verb-prefixed',
        cli: 'claude',
        model: 'fable-5-1',
        effort: 'high',
        condition: 'mcp-only',
        seed: 3,
        callIndex: 0,
      });

      // The per-project audit log lives under the home directory; headless mode
      // with an evaluation log writes nothing there.
      expect(existsSync(join(home, '.pyric', 'projects'))).toBe(false);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('logs a call the SDK rejects on schema validation, with ok false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-headless-reject-'));
    try {
      const logPath = join(dir, 'events.ndjson');
      const session = await openSession(dir, evalEnv(logPath));

      // `path` is a required string; a number never reaches the handler.
      const rejected = await session.client.callTool({
        name: 'firestore_get_document',
        arguments: { path: 42 },
      });
      expect(rejected.isError).toBe(true);
      await session.close();

      const events = readEvents(logPath);
      expect(events.length).toBe(1);
      const [event] = events as [LoggedEvent];
      expect(event.tool).toBe('firestore_get_document');
      expect(event.result.summary).toContain('Input validation error');
      expect(event.schemaRejected).toBe(true);
      expect(event.isError).toBe(true);
      expect(event.result.ok).toBe(false);
      expect(event.run.callIndex).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flushes the snapshot on close, before the debounce would have fired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-headless-flush-'));
    try {
      const session = await openSession(dir, {});
      const created = await session.client.callTool({
        name: 'firestore_create_document',
        arguments: { path: 'rooms/r1/msgs/m1', data: { body: 'persisted' } },
      });
      expect(created.isError).toBeFalsy();

      const snapshotPath = join(dir, HEADLESS_STATE_RELATIVE);
      expect(existsSync(snapshotPath)).toBe(false); // still inside the debounce window

      const code = await session.close();
      expect(code).toBe(0);
      expect(existsSync(snapshotPath)).toBe(true);
      expect(readFileSync(snapshotPath, 'utf8')).toContain('persisted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads project rules and serves the default surface for any surface id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-headless-surface-'));
    try {
      writeFileSync(join(dir, 'firestore.rules'), "rules_version = '2';\n", 'utf8');
      const session = await openSession(dir, {});
      const listed = await session.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        [...DEFAULT_MCP_TOOL_NAMES].sort(),
      );
      await session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('headless event writer selection', () => {
  it('records nothing when PYRIC_EVAL_LOG is absent or empty', () => {
    expect(createHeadlessEventWriter({})).toBe(null);
    expect(createHeadlessEventWriter({ PYRIC_EVAL_LOG: '  ' })).toBe(null);
  });

  it('builds a server for a surface id it does not recognise', () => {
    expect(buildHeadlessMcpServer(initializeSandbox(), { surface: 'noun-prefixed' })).toBeTruthy();
  });
});
