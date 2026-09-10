/**
 * One CLI command that answers about a running bridge, rather than about this
 * project's own in-process sandbox.
 *
 * A bridge holds state no other process has: which clients are connected, and
 * the identity it records for each of them. A command about that state cannot
 * be served locally, so it finds the running sandbox bridge the way every
 * other attaching client does (`.pyric/serve.json`, then the port scan, via
 * `serve/discovery.ts`) and calls the identically named MCP tool. The handler
 * that answers is the one an agent reaches, so the CLI and MCP surfaces cannot
 * drift.
 *
 * Exit codes follow the CLI convention: 0 success, 1 invalid options or no
 * bridge, 2 a bridge that answered with a failure.
 */

import type { ParsedArgs } from './parse-args.js';
import { discoverServe, type Discovered } from '../serve/discovery.js';
import { NO_BRIDGE_CLI_MESSAGE } from '../auth/identity.js';

/** A tool result as the bridge returns it. */
export interface BridgeToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** What a bridge-backed command reads and writes, injectable for tests. */
export interface BridgeCommandDeps {
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  /** Injected in tests; defaults to the shared serve discovery. */
  discover?: (cwd: string, log?: (m: string) => void) => Promise<Discovered | null>;
  /** Injected in tests; defaults to a one-shot MCP call against the bridge. */
  callTool?: (
    mcpUrl: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<BridgeToolResult>;
}

/**
 * Read one MCP tool response. A bridge that serves the tool answers with the
 * tool result as JSON in a text block. A bridge that does not serve it answers
 * with a plain error string, so report what it said rather than a parse
 * failure, and name the likely cause.
 */
export function parseToolResponse(
  tool: string,
  response: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  },
): BridgeToolResult {
  const text = response.content?.find((block) => block.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(text) as BridgeToolResult;
    return { ok: parsed.ok, summary: parsed.summary, data: parsed.data };
  } catch {
    return {
      ok: false,
      summary:
        `${text || 'the bridge returned an empty response'} ` +
        `(the running bridge may predate the ${tool} tool; restart it with the current pyric).`,
      data: { code: 'auth/unsupported-bridge' },
    };
  }
}

/**
 * One MCP `tools/call` against a running bridge. The SDK client is imported
 * lazily: it is heavy and only these commands need it.
 */
async function callBridgeTool(
  mcpUrl: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<BridgeToolResult> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const client = new Client({ name: 'pyric-cli', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  try {
    await client.connect(transport);
    return parseToolResponse(
      tool,
      (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      },
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Run one bridge-backed command: discover the bridge, call the tool, and
 * render what it answered. `--json` prints the whole result instead.
 */
export async function runBridgeCommand(
  command: string,
  tool: string,
  args: Record<string, unknown>,
  parsed: ParsedArgs,
  deps: BridgeCommandDeps,
  render: (result: BridgeToolResult, out: { write(s: string): void }) => void,
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const json = parsed.flags.get('json') === true;

  const found = await (deps.discover ?? discoverServe)(cwd, () => {});
  if (!found) {
    err.write(`${NO_BRIDGE_CLI_MESSAGE}\n`);
    return 1;
  }

  let result: BridgeToolResult;
  try {
    result = await (deps.callTool ?? callBridgeTool)(found.mcpUrl, tool, args);
  } catch (error) {
    err.write(
      `pyric ${command}: the bridge at ${found.mcpUrl} did not answer ` +
        `(${error instanceof Error ? error.message : String(error)}).\n`,
    );
    return 2;
  }

  if (json) {
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 2;
  }
  if (!result.ok) {
    err.write(`pyric ${command}: ${result.summary}\n`);
    return 2;
  }
  render(result, out);
  return 0;
}
