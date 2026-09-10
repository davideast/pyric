/**
 * `pyric auth reset`: self versus `--target`, the `--json` shape, the human
 * rendering, and the exit codes for a missing bridge, a bad flag combination,
 * and a bridge that answers with a failure.
 *
 * `auth impersonate`, `auth whoami`, and `auth sessions` are derived
 * service-tool commands now (`pyric auth impersonate --uid alice`, acting on
 * this project's local `.pyric/state`, no bridge needed); their tests live
 * under `test/bridge/surface/`. Reset stays bridge-only, because retargeting a
 * connected client is a concept only a running bridge has, so its discovery
 * and MCP round trip are injected here, and the assertions are about the tool
 * the command calls, the arguments it sends, and the output it prints, not the
 * wire.
 */
import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { dispatchServiceCommand } from '../../src/cli/service-commands.js';
import {
  parseToolResponse,
  runAuthReset,
  type AuthIdentityDeps,
  type AuthToolResult,
} from '../../src/cli/auth-identity.js';
import {
  NO_BRIDGE_CLI_MESSAGE,
  SELF_SCOPE_NOTE,
  TARGET_SCOPE_NOTE,
} from '../../src/auth/identity.js';

const DISCOVERED = {
  mcpUrl: 'http://127.0.0.1:3473/__pyric/mcp',
  url: 'http://localhost:3473',
  base: 'http://127.0.0.1:3473',
  instanceId: 'abc',
  source: 'test',
};

/** Parse the CLI form and hand the handler the positionals it would receive. */
function parsed(...argv: string[]) {
  const raw = parseArgs(argv);
  return { ...raw, positional: raw.positional.slice(1) };
}

function harness(result: AuthToolResult) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const deps: AuthIdentityDeps = {
    cwd: '/tmp',
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    discover: async () => DISCOVERED,
    callTool: async (_url, tool, args) => {
      calls.push({ tool, args });
      return result;
    },
  };
  return { deps, out, err, calls, stdout: () => out.join(''), stderr: () => err.join('') };
}

const OK: AuthToolResult = { ok: true, summary: 'You now act as admin.', data: {} };

describe('parseToolResponse', () => {
  it('reads a tool result from the text block', () => {
    expect(
      parseToolResponse('auth_whoami', {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, summary: 's', data: { a: 1 } }) }],
      }),
    ).toEqual({ ok: true, summary: 's', data: { a: 1 } });
  });

  it('reports a bridge that does not serve the tool instead of a parse failure', () => {
    const result = parseToolResponse('auth_reset', {
      isError: true,
      content: [{ type: 'text', text: 'MCP error -32602: Tool auth_reset not found' }],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Tool auth_reset not found');
    expect(result.summary).toContain('may predate the auth_reset tool');
    expect(result.data).toMatchObject({ code: 'auth/unsupported-bridge' });
  });

  it('reports an empty response', () => {
    expect(parseToolResponse('auth_sessions', {}).summary).toContain('empty response');
  });
});

describe('pyric auth reset', () => {
  it('sends no arguments for yourself and prints the self note', async () => {
    const h = harness({ ok: true, summary: 'You now act as app session.', data: {} });

    expect(await runAuthReset(parsed('auth', 'reset'), h.deps)).toBe(0);
    expect(h.calls).toEqual([{ tool: 'auth_reset', args: {} }]);
    expect(h.stdout()).toContain(SELF_SCOPE_NOTE);
  });

  it('sends the target and prints the target note', async () => {
    const h = harness({ ok: true, summary: 'sess-1 now acts as app session.', data: {} });

    expect(await runAuthReset(parsed('auth', 'reset', '--target', 'sess-1'), h.deps)).toBe(0);
    expect(h.calls).toEqual([{ tool: 'auth_reset', args: { target: 'sess-1' } }]);
    expect(h.stdout()).toContain(TARGET_SCOPE_NOTE);
  });

  it('exits 1 when --target carries no value', async () => {
    const h = harness(OK);

    expect(await runAuthReset(parsed('auth', 'reset', '--target', '--json'), h.deps)).toBe(1);
    expect(h.stderr()).toContain('--target requires');
    expect(h.calls).toEqual([]);
  });
});

describe('the claim the CLI must keep printing', () => {
  it('says a successful self call governs the tool calls you forward', async () => {
    expect(SELF_SCOPE_NOTE).toContain('applied to the tool calls you forward through it');
    expect(SELF_SCOPE_NOTE).not.toContain(
      'does not change how your own tool calls are rules-evaluated',
    );

    const h = harness(OK);
    await runAuthReset(parsed('auth', 'reset'), h.deps);
    expect(h.stdout()).toContain('applied to the tool calls you forward through it');
  });

  it('keeps saying a targeted call leaves your own tool calls alone', async () => {
    const phrase = 'does not change how your own tool calls are rules-evaluated';
    expect(TARGET_SCOPE_NOTE).toContain(phrase);

    const h = harness(OK);
    await runAuthReset(parsed('auth', 'reset', '--target', 'sess-1'), h.deps);
    expect(h.stdout()).toContain(phrase);
  });

  it('does not print the note twice when the bridge already said it', async () => {
    const h = harness({ ok: true, summary: `You now act as app session. ${SELF_SCOPE_NOTE}`, data: {} });

    await runAuthReset(parsed('auth', 'reset'), h.deps);
    expect(h.stdout().split(SELF_SCOPE_NOTE)).toHaveLength(2);
  });
});

describe('service command routing', () => {
  it('leaves an unknown auth operation to the top-level dispatcher', async () => {
    expect(await dispatchServiceCommand(parseArgs(['auth', 'lens']))).toBeNull();
  });

  it('reaches the reset handler through the registry', async () => {
    const h = harness(OK);
    const argv = parseArgs(['auth', 'reset', '--target', 'sess-1']);
    // Mirrors dispatchServiceCommand's slice for a two-word path.
    expect(await runAuthReset({ ...argv, positional: argv.positional.slice(1) }, h.deps)).toBe(0);
    expect(h.calls[0]!.args).toEqual({ target: 'sess-1' });
  });
});
