/**
 * `pyric auth reset` and `pyric auth sessions`: the CLI view of who this
 * bridge's connected clients, and its own callers, act as.
 *
 * Impersonating an identity and reading whose calls run under it are
 * `auth impersonate` and `auth whoami` on the service surface now
 * (`packages/cli/src/bridge/surface/methods/auth/`), which act on this
 * project's local `.pyric/state` and need no running bridge. Reset and
 * sessions stay here because "connected clients" is a concept a bridge alone
 * has: the state lives in the bridge process, not this one, so both commands
 * discover the running sandbox bridge (`.pyric/serve.json`, then the port
 * scan, via `serve/discovery.ts`) and call the identically named MCP tool.
 * Those are the same handlers an agent calls, so the CLI and MCP surfaces
 * cannot drift: the logic lives once, in `../auth/identity.ts`, and both
 * surfaces reach it through one tool.
 *
 * `--target` names another connected client. Without it a command acts on
 * this caller's own bridge identity, which the bridge records but does not
 * yet stamp on forwarded tool calls. See `../auth/identity.ts` for the traced
 * behaviour, and {@link SELF_SCOPE_NOTE} for the sentence both surfaces print.
 *
 * Exit codes follow the CLI convention: 0 success, 1 invalid options or no
 * bridge, 2 a bridge that answered with a failure.
 */

import type { ParsedArgs } from './parse-args.js';
import { discoverServe, type Discovered } from '../serve/discovery.js';
import {
  NO_BRIDGE_CLI_MESSAGE,
  SELF_SCOPE_NOTE,
  TARGET_SCOPE_NOTE,
  describeIdentity,
} from '../auth/identity.js';

/** A tool result as the bridge returns it. */
export interface AuthToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface AuthIdentityDeps {
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
  ) => Promise<AuthToolResult>;
}

/** Read a flag that must carry a string value, not a bare boolean. */
function stringFlag(parsed: ParsedArgs, key: string): string | null | undefined {
  const value = parsed.flags.get(key);
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** The `target` argument, or an error when `--target` was given without a value. */
function targetFromFlags(parsed: ParsedArgs): { target?: string } | { error: string } {
  const target = stringFlag(parsed, 'target');
  if (target === null) {
    return { error: '--target requires the target id of a connected client.' };
  }
  return target === undefined ? {} : { target };
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
): AuthToolResult {
  const text = response.content?.find((block) => block.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(text) as AuthToolResult;
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
): Promise<AuthToolResult> {
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

async function run(
  command: string,
  tool: string,
  args: Record<string, unknown>,
  parsed: ParsedArgs,
  deps: AuthIdentityDeps,
  render: (result: AuthToolResult, out: { write(s: string): void }) => void,
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

  let result: AuthToolResult;
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

interface ListedSession {
  target: string;
  platform: string;
  deviceLabel?: string;
  identity: string;
}

export async function runAuthSessions(
  parsed: ParsedArgs,
  deps: AuthIdentityDeps = {},
): Promise<number> {
  return run('auth sessions', 'auth_sessions', {}, parsed, deps, (result, out) => {
    out.write(`${result.summary}\n`);
    for (const session of (result.data as { sessions?: ListedSession[] })?.sessions ?? []) {
      const label = session.deviceLabel ? ` (${session.deviceLabel})` : '';
      out.write(`  ${session.target}  ${session.platform}${label}  ${session.identity}\n`);
    }
  });
}

/**
 * Print the summary, and the sentence that names whose calls actually change
 * when the bridge has not already said it. A current bridge puts the note in
 * the summary; an older answer, or a stubbed one, does not, and the CLI must
 * not be the surface that drops it.
 */
function withScopeNote(note: string) {
  return (result: AuthToolResult, out: { write(s: string): void }) => {
    out.write(`${result.summary}\n`);
    if (!result.summary.includes(note)) out.write(`${note}\n`);
  };
}

export async function runAuthReset(
  parsed: ParsedArgs,
  deps: AuthIdentityDeps = {},
): Promise<number> {
  const err = deps.stderr ?? process.stderr;
  const scope = targetFromFlags(parsed);
  if ('error' in scope) {
    err.write(`pyric auth reset: ${scope.error}\n`);
    return 1;
  }
  return run(
    'auth reset',
    'auth_reset',
    scope,
    parsed,
    deps,
    withScopeNote(scope.target === undefined ? SELF_SCOPE_NOTE : TARGET_SCOPE_NOTE),
  );
}

export { describeIdentity };
