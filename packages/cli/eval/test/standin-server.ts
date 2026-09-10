/**
 * A stand-in in-process MCP server for the pipeline test.
 *
 * The real server is built on another branch. This one implements only what the
 * runner depends on: it speaks stdio MCP, renders two operations under their
 * verb-prefixed names, appends one section 3 event per call to `PYRIC_EVAL_LOG`,
 * and flushes `.pyric/state/in-process.json` before it exits. It honours
 * `PYRIC_PROJECT_DIR` the way the real server does, because the runner points
 * both at a state directory away from the process cwd. Everything it does not
 * need is left out on purpose, so it never becomes a second implementation the
 * eval quietly depends on.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, getDoc, setDoc } from 'pyric/firestore';
import { loadSandboxSnapshot, saveSandboxSnapshot } from '../../src/bridge/server/in-process.js';

const projectDir = resolve(process.cwd(), process.env.PYRIC_PROJECT_DIR ?? '.');
const logPath = process.env.PYRIC_EVAL_LOG;

const runBlock = {
  runId: process.env.PYRIC_EVAL_RUN_ID ?? '',
  taskId: process.env.PYRIC_EVAL_TASK_ID ?? '',
  variant: process.env.PYRIC_EVAL_VARIANT ?? '',
  cli: process.env.PYRIC_EVAL_CLI ?? '',
  model: process.env.PYRIC_EVAL_MODEL ?? '',
  effort: process.env.PYRIC_EVAL_EFFORT ?? '',
  condition: process.env.PYRIC_EVAL_CONDITION ?? '',
  seed: Number(process.env.PYRIC_EVAL_SEED ?? '0'),
};

let callIndex = 0;

function record(
  tool: string,
  operation: string,
  args: Record<string, unknown>,
  result: { ok: boolean; summary: string; data?: unknown },
  durationMs: number,
): void {
  if (logPath === undefined) return;
  const event = {
    timestamp: new Date().toISOString(),
    mode: 'sandbox',
    // The bridge's own project label. Nothing in the eval keys on it.
    project: 'sandbox',
    tool,
    operation,
    action: null,
    args,
    result,
    durationMs,
    schemaRejected: false,
    isError: !result.ok,
    run: { ...runBlock, callIndex },
  };
  callIndex += 1;
  appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8');
}

const sandbox = initializeSandbox();
loadSandboxSnapshot(sandbox, projectDir);
const db = getAdminFirestore(sandbox);

const server = new McpServer({ name: 'pyric-standin', version: '1' });

(server.tool as unknown as Function)(
  'write_firestore_document',
  'Write a document at a path.',
  { path: z.string(), data: z.record(z.unknown()) },
  async (args: { path: string; data: Record<string, unknown> }) => {
    const startedAt = Date.now();
    await setDoc(doc(db, args.path), args.data);
    const result = { ok: true, summary: `wrote ${args.path}` };
    record('write_firestore_document', 'write_firestore_document', args, result, Date.now() - startedAt);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: false };
  },
);

(server.tool as unknown as Function)(
  'get_firestore_document',
  'Read a document at a path.',
  { path: z.string() },
  async (args: { path: string }) => {
    const startedAt = Date.now();
    const snap = await getDoc(doc(db, args.path));
    const exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
    const result = { ok: exists, summary: args.path, data: snap.data() ?? null };
    record('get_firestore_document', 'get_firestore_document', args, result, Date.now() - startedAt);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: !result.ok,
    };
  },
);

const transport = new StdioServerTransport();

function shutdown(): void {
  saveSandboxSnapshot(sandbox, projectDir);
  void server.close().then(() => process.exit(0));
}

transport.onclose = shutdown;
process.stdin.once('end', shutdown);
process.once('SIGTERM', shutdown);
await server.connect(transport);
