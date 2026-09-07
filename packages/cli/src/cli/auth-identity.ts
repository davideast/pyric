/**
 * `pyric auth impersonate`, `pyric auth reset`, `pyric auth whoami`, and
 * `pyric auth sessions` — the CLI view of who this bridge's clients, and its
 * own callers, act as.
 *
 * The state lives in the bridge process, not this one, so every command
 * discovers the running sandbox bridge (`.pyric/serve.json`, then the port
 * scan, via `serve/discovery.ts`) and calls the identically named MCP tool.
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

function hasFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags.get(key) === true;
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
 * The arguments `auth_impersonate` takes, from the flags and the positional
 * uid. Exactly one of a uid, `--admin`, and `--anonymous` is accepted.
 */
export function impersonateArgs(
  parsed: ParsedArgs,
): { args: Record<string, unknown> } | { error: string } {
  const uid = parsed.positional[0];
  const admin = hasFlag(parsed, 'admin');
  const anonymous = hasFlag(parsed, 'anonymous');
  const selected = [uid !== undefined, admin, anonymous].filter(Boolean).length;

  if (selected === 0) {
    return { error: 'name a uid, or pass --admin or --anonymous.' };
  }
  if (selected > 1) {
    return { error: 'pick exactly one of a uid, --admin, and --anonymous.' };
  }

  const scope = targetFromFlags(parsed);
  if ('error' in scope) return { error: scope.error };

  if (uid === undefined) {
    if (parsed.flags.has('tenant') || parsed.flags.has('claims')) {
      return { error: '--tenant and --claims apply only to a uid.' };
    }
    return { args: { ...(admin ? { admin: true } : { anonymous: true }), ...scope } };
  }

  const tenant = stringFlag(parsed, 'tenant');
  if (tenant === null) return { error: '--tenant requires a tenant id.' };

  const claimsRaw = stringFlag(parsed, 'claims');
  if (claimsRaw === null) return { error: '--claims requires a JSON object.' };
  let claims: Record<string, unknown> | undefined;
  if (claimsRaw !== undefined) {
    let parsedClaims: unknown;
    try {
      parsedClaims = JSON.parse(claimsRaw);
    } catch (error) {
      return {
        error: `--claims is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (typeof parsedClaims !== 'object' || parsedClaims === null || Array.isArray(parsedClaims)) {
      return { error: '--claims must be a JSON object of custom claims.' };
    }
    claims = parsedClaims as Record<string, unknown>;
  }

  return {
    args: {
      uid,
      ...(tenant !== undefined ? { tenant } : {}),
      ...(claims !== undefined ? { claims } : {}),
      ...scope,
    },
  };
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

export async function runAuthWhoami(
  parsed: ParsedArgs,
  deps: AuthIdentityDeps = {},
): Promise<number> {
  return run('auth whoami', 'auth_whoami', {}, parsed, deps, withScopeNote(SELF_SCOPE_NOTE));
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

export async function runAuthImpersonate(
  parsed: ParsedArgs,
  deps: AuthIdentityDeps = {},
): Promise<number> {
  const err = deps.stderr ?? process.stderr;
  const built = impersonateArgs(parsed);
  if ('error' in built) {
    err.write(
      `pyric auth impersonate: ${built.error}\n` +
        'Usage: pyric auth impersonate <uid> [--tenant <id>] [--claims <json>] [--target <id>], ' +
        'pyric auth impersonate --admin [--target <id>], or ' +
        'pyric auth impersonate --anonymous [--target <id>]. ' +
        'Run `pyric auth sessions` for connected target ids.\n',
    );
    return 1;
  }
  return run(
    'auth impersonate',
    'auth_impersonate',
    built.args,
    parsed,
    deps,
    withScopeNote(built.args.target === undefined ? SELF_SCOPE_NOTE : TARGET_SCOPE_NOTE),
  );
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
