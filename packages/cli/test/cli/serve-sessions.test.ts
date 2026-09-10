/**
 * `pyric serve sessions`: the rows it prints for a running bridge's connected
 * clients, the `--json` shape, and the exit codes for a missing bridge and a
 * bridge that answers with a failure.
 *
 * The ids these rows carry are the ones `--target` takes, so this is the
 * command that makes `pyric auth reset --target <id>` usable from a terminal.
 * Discovery and the MCP round trip are injected, so the assertions are about
 * the tool the command calls and the output it prints, not the wire.
 */
import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { dispatchServiceCommand } from '../../src/cli/service-commands.js';
import { SERVICE_COMMANDS } from '../../src/cli/service-commands.generated.js';
import { runServeSessions } from '../../src/cli/serve-sessions.js';
import type { BridgeCommandDeps, BridgeToolResult } from '../../src/cli/bridge-tool-call.js';
import { NO_BRIDGE_CLI_MESSAGE } from '../../src/auth/identity.js';

const DISCOVERED = {
  mcpUrl: 'http://127.0.0.1:3473/__pyric/mcp',
  url: 'http://localhost:3473',
  base: 'http://127.0.0.1:3473',
  instanceId: 'abc',
  source: 'test',
};

const TWO_CLIENTS: BridgeToolResult = {
  ok: true,
  summary: '2 connected clients',
  data: {
    total: 2,
    sessions: [
      { target: 'sess-a', platform: 'kotlin', deviceLabel: 'Pixel 10', identity: 'as alice' },
      { target: 'sess-b', platform: 'web', identity: 'app session' },
    ],
  },
};

/** Parse the CLI form and hand the handler the positionals it would receive. */
function parsed(...argv: string[]) {
  const raw = parseArgs(argv);
  return { ...raw, positional: raw.positional.slice(1) };
}

function harness(result: BridgeToolResult) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const deps: BridgeCommandDeps = {
    cwd: '/tmp',
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    discover: async () => DISCOVERED,
    callTool: async (_url, tool, args) => {
      calls.push({ tool, args });
      return result;
    },
  };
  return { deps, calls, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('pyric serve sessions', () => {
  it('prints one row per connected client, with the id --target takes', async () => {
    const h = harness(TWO_CLIENTS);
    expect(await runServeSessions(parsed('serve', 'sessions'), h.deps)).toBe(0);

    expect(h.calls).toEqual([{ tool: 'auth_sessions', args: {} }]);
    expect(h.stdout()).toBe(
      '2 connected clients\n' +
        '  sess-a  kotlin (Pixel 10)  as alice\n' +
        '  sess-b  web  app session\n',
    );
  });

  it('prints the whole result under --json', async () => {
    const h = harness(TWO_CLIENTS);
    expect(await runServeSessions(parsed('serve', 'sessions', '--json'), h.deps)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual(TWO_CLIENTS as unknown as Record<string, unknown>);
  });

  it('reports a bridge that is not running with exit 1', async () => {
    const h = harness(TWO_CLIENTS);
    expect(
      await runServeSessions(parsed('serve', 'sessions'), { ...h.deps, discover: async () => null }),
    ).toBe(1);
    expect(h.stderr()).toContain(NO_BRIDGE_CLI_MESSAGE);
  });

  it('reports a bridge that answered with a failure with exit 2', async () => {
    const h = harness({ ok: false, summary: 'no bridge is running here.' });
    expect(await runServeSessions(parsed('serve', 'sessions'), h.deps)).toBe(2);
    expect(h.stderr()).toContain('pyric serve sessions: no bridge is running here.');
  });

  it('leaves an unknown serve operation to the top-level dispatcher', async () => {
    expect(await dispatchServiceCommand(parseArgs(['serve', 'clients']))).toBeNull();
  });

  it('is registered in the command table under the serve word', () => {
    expect(SERVICE_COMMANDS.map((command) => command.path.join(' '))).toContain('serve sessions');
  });
});
