/**
 * `pyric call <tool> <op>` reaches every MCP tool operation from the terminal.
 *
 * Target resolution mirrors `pyric mcp`: a running `pyric sandbox --bridge`
 * found through `.pyric/serve.json` (or the port named by `--port`) receives
 * the call over its MCP endpoint. With no sandbox running, an in-process
 * operation runs against the headless server `bridge/server/headless.ts`
 * builds, connected over the SDK's in-memory transport; a forwarded
 * operation has no sandbox to reach and fails with exit code 2.
 *
 * Every call travels through an MCP client, so validation, routing, and the
 * result envelope are exactly what an agent sees. The envelope prints on
 * stdout when the operation succeeded and on stderr when it did not.
 *
 * Exit codes follow the CLI contract: 0 success, 1 usage error (unknown tool
 * or op, malformed arguments), 2 runtime error (a structured tool error, no
 * sandbox for a forwarded op, an unreachable target).
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DEFAULT_MCP_TOOL_OPS } from '../bridge/server/mcp-contract.js';
import { toolOps, type ToolTransport } from '../bridge/tool-records.js';
import { discoverServe, healthyBase } from '../serve/discovery.js';
import type { ParsedArgs } from './parse-args.js';

export const CALL_USAGE = 'pyric call <tool> <op> [--args <json>] [--stdin] [--port <n>] [--json]';

/** Injectable seams for tests: discovery, stdin, and the output streams. */
export interface CallDeps {
  cwd?: string;
  discover?: typeof discoverServe;
  /** Ports discovery scans when no pointer resolves; tests pass `[]` to stay hermetic. */
  scanPorts?: number[];
  readStdin?: () => Promise<string>;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

interface Envelope {
  ok: boolean;
  summary: string;
  data?: unknown;
  [key: string]: unknown;
}

function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function opTransport(tool: string, op: string): ToolTransport | undefined {
  return toolOps().find((candidate) => candidate.tool === tool && candidate.op === op)?.transport;
}

/** Fields of the call from `--args` or `--stdin`; `null` after a usage error has been written. */
async function readFields(
  parsed: ParsedArgs,
  deps: CallDeps,
  err: { write(s: string): void },
): Promise<Record<string, unknown> | null> {
  const argsFlag = parsed.flags.get('args');
  const stdinFlag = parsed.flags.get('stdin') === true;
  if (argsFlag !== undefined && stdinFlag) {
    err.write('pyric call: pass either --args or --stdin, not both.\n');
    return null;
  }
  let text: string;
  let source: string;
  if (stdinFlag) {
    text = await (deps.readStdin ?? defaultReadStdin)();
    source = 'stdin';
  } else if (argsFlag !== undefined) {
    if (typeof argsFlag !== 'string') {
      err.write('pyric call: --args takes a JSON object.\n');
      return null;
    }
    text = argsFlag;
    source = '--args';
  } else {
    return {};
  }
  let fields: unknown;
  try {
    fields = JSON.parse(text);
  } catch (e) {
    err.write(`pyric call: failed to parse ${source} JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
  if (!isPlainObject(fields)) {
    err.write(`pyric call: ${source} must be a JSON object of the op's fields.\n`);
    return null;
  }
  if ('op' in fields) {
    err.write("pyric call: the op is the second argument; do not also pass 'op' in the fields.\n");
    return null;
  }
  return fields;
}

type Target =
  | { kind: 'attached'; mcpUrl: string; via: string }
  | { kind: 'headless' };

/** Where the call goes; `null` after a runtime error has been written. */
async function resolveTarget(
  parsed: ParsedArgs,
  deps: CallDeps,
  err: { write(s: string): void },
): Promise<Target | null | 'usage'> {
  const portFlag = parsed.flags.get('port');
  if (portFlag !== undefined) {
    const port = typeof portFlag === 'string' ? Number(portFlag) : NaN;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      err.write(`pyric call: invalid --port '${String(portFlag)}'.\n`);
      return 'usage';
    }
    const hit = await healthyBase(port);
    if (!hit) {
      err.write(`pyric call: no sandbox bridge answers on port ${port}; start \`pyric sandbox --bridge\`.\n`);
      return null;
    }
    return { kind: 'attached', mcpUrl: `${hit.base}/__pyric/mcp`, via: `port ${port}` };
  }
  const found = await (deps.discover ?? discoverServe)(
    deps.cwd ?? process.cwd(),
    (m) => err.write(`pyric call: ${m}\n`),
    deps.scanPorts,
  );
  if (found) return { kind: 'attached', mcpUrl: found.mcpUrl, via: found.source };
  return { kind: 'headless' };
}

async function connectClient(transport: Transport): Promise<Client> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'pyric-call', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** One tool call through an MCP client, returning the bridge's envelope. */
async function callThrough(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const result = await client.callTool({ name: tool, arguments: args });
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected tool result shape: ${JSON.stringify(result)}`);
  }
  const envelope = JSON.parse(first.text) as unknown;
  if (!isPlainObject(envelope) || typeof envelope.ok !== 'boolean') {
    throw new Error(`unexpected tool result envelope: ${first.text}`);
  }
  return envelope as Envelope;
}

async function callAttached(mcpUrl: string, tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const client = await connectClient(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  try {
    return await callThrough(client, tool, args);
  } finally {
    await client.close().catch(() => {});
  }
}

async function callHeadless(tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const [{ buildHeadlessMcpServer }, { resolveBridgeScope }, { initializeSandbox }, { InMemoryTransport }] =
    await Promise.all([
      import('../bridge/server/headless.js'),
      import('../bridge/server/scope.js'),
      import('pyric/sandbox'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
    ]);
  const credentials = await resolveBridgeScope();
  const server = buildHeadlessMcpServer(
    initializeSandbox(),
    credentials.scope ? { scope: credentials.scope } : {},
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = await connectClient(clientTransport);
  try {
    return await callThrough(client, tool, args);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export async function runCall(parsed: ParsedArgs, deps: CallDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const [tool, op, ...rest] = parsed.positional;

  if (!tool || !op || rest.length > 0) {
    err.write(`Usage: ${CALL_USAGE}\n`);
    return 1;
  }
  const validOps = DEFAULT_MCP_TOOL_OPS[tool];
  if (!validOps) {
    err.write(
      `pyric call: unknown tool '${tool}'; valid tools: ${Object.keys(DEFAULT_MCP_TOOL_OPS).join(', ')}\n`,
    );
    return 1;
  }
  if (!validOps.includes(op)) {
    err.write(`pyric call: unknown op '${op}' for ${tool}; valid ops: ${validOps.join(', ')}\n`);
    return 1;
  }

  const fields = await readFields(parsed, deps, err);
  if (fields === null) return 1;

  const target = await resolveTarget(parsed, deps, err);
  if (target === 'usage') return 1;
  if (target === null) return 2;

  const transport = opTransport(tool, op);
  if (target.kind === 'headless' && transport === 'forwarded') {
    err.write(
      `pyric call: ${tool}.${op} runs in the sandbox and none is running; start \`pyric sandbox --bridge\` and retry.\n`,
    );
    return 2;
  }

  const args = { op, ...fields };
  let envelope: Envelope;
  try {
    envelope =
      target.kind === 'attached'
        ? await callAttached(target.mcpUrl, tool, args)
        : await callHeadless(tool, args);
  } catch (e) {
    const where = target.kind === 'attached' ? ` (${target.via})` : '';
    err.write(`pyric call: ${tool}.${op} failed${where}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const rendered = parsed.flags.get('json') === true
    ? JSON.stringify(envelope)
    : JSON.stringify(envelope, null, 2);
  if (envelope.ok) {
    out.write(`${rendered}\n`);
    return 0;
  }
  err.write(`${rendered}\n`);
  return 2;
}
