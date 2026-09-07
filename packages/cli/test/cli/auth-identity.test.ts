/**
 * `pyric auth impersonate` / `reset` / `whoami` / `sessions`: flag parsing for
 * every mode, self versus `--target`, the `--json` shape, the human rendering,
 * and the exit codes for a missing bridge, a bad flag combination, and a
 * bridge that answers with a failure.
 *
 * Discovery and the MCP round trip are injected, so the assertions are about
 * the tool each command calls, the arguments it sends, and the output it
 * prints, not the wire.
 */
import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { dispatchServiceCommand } from '../../src/cli/service-commands.js';
import {
  impersonateArgs,
  parseToolResponse,
  runAuthImpersonate,
  runAuthReset,
  runAuthSessions,
  runAuthWhoami,
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

describe('impersonateArgs', () => {
  it('builds each of the three selectors', () => {
    expect(impersonateArgs(parsed('auth', 'impersonate', 'alice'))).toEqual({
      args: { uid: 'alice' },
    });
    expect(impersonateArgs(parsed('auth', 'impersonate', '--admin'))).toEqual({
      args: { admin: true },
    });
    expect(impersonateArgs(parsed('auth', 'impersonate', '--anonymous'))).toEqual({
      args: { anonymous: true },
    });
  });

  it('carries tenant and claims onto a uid', () => {
    expect(
      impersonateArgs(
        parsed(
          'auth', 'impersonate', 'alice',
          '--tenant', 'tenant-acme',
          '--claims', '{"role":"editor","tier":2}',
        ),
      ),
    ).toEqual({
      args: { uid: 'alice', tenant: 'tenant-acme', claims: { role: 'editor', tier: 2 } },
    });
  });

  it('carries --target through for each selector', () => {
    expect(impersonateArgs(parsed('auth', 'impersonate', 'alice', '--target', 'sess-1'))).toEqual({
      args: { uid: 'alice', target: 'sess-1' },
    });
    expect(impersonateArgs(parsed('auth', 'impersonate', '--admin', '--target', 'sess-1'))).toEqual({
      args: { admin: true, target: 'sess-1' },
    });
  });

  it('rejects no selector, two selectors, and misuse of the uid-only flags', () => {
    expect(impersonateArgs(parsed('auth', 'impersonate'))).toMatchObject({
      error: expect.stringContaining('name a uid'),
    });
    expect(impersonateArgs(parsed('auth', 'impersonate', '--admin', '--anonymous'))).toMatchObject({
      error: expect.stringContaining('exactly one'),
    });
    expect(impersonateArgs(parsed('auth', 'impersonate', 'alice', '--admin'))).toMatchObject({
      error: expect.stringContaining('exactly one'),
    });
    expect(
      impersonateArgs(parsed('auth', 'impersonate', '--admin', '--tenant', 't')),
    ).toMatchObject({ error: expect.stringContaining('--tenant and --claims') });
    expect(
      impersonateArgs(parsed('auth', 'impersonate', 'alice', '--target')),
    ).toMatchObject({ error: expect.stringContaining('--target requires') });
  });

  it('rejects claims that are not a JSON object', () => {
    expect(
      impersonateArgs(parsed('auth', 'impersonate', 'a', '--claims', 'not-json')),
    ).toMatchObject({ error: expect.stringContaining('not valid JSON') });
    expect(
      impersonateArgs(parsed('auth', 'impersonate', 'a', '--claims', '[1,2]')),
    ).toMatchObject({ error: expect.stringContaining('JSON object') });
  });
});

describe('parseToolResponse', () => {
  it('reads a tool result from the text block', () => {
    expect(
      parseToolResponse('auth_whoami', {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, summary: 's', data: { a: 1 } }) }],
      }),
    ).toEqual({ ok: true, summary: 's', data: { a: 1 } });
  });

  it('reports a bridge that does not serve the tool instead of a parse failure', () => {
    const result = parseToolResponse('auth_impersonate', {
      isError: true,
      content: [{ type: 'text', text: 'MCP error -32602: Tool auth_impersonate not found' }],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Tool auth_impersonate not found');
    expect(result.summary).toContain('may predate the auth_impersonate tool');
    expect(result.data).toMatchObject({ code: 'auth/unsupported-bridge' });
  });

  it('reports an empty response', () => {
    expect(parseToolResponse('auth_sessions', {}).summary).toContain('empty response');
  });
});

describe('pyric auth sessions', () => {
  it('prints one line per connected client', async () => {
    const h = harness({
      ok: true,
      summary: '2 connected clients',
      data: {
        total: 2,
        sessions: [
          { target: 'sess-1', platform: 'flutter', deviceLabel: 'iPhone 17 Pro', identity: 'app session' },
          { target: 'sess-2', platform: 'studio', identity: 'as alice · tenant acme' },
        ],
      },
    });

    expect(await runAuthSessions(parsed('auth', 'sessions'), h.deps)).toBe(0);
    expect(h.calls).toEqual([{ tool: 'auth_sessions', args: {} }]);
    expect(h.stdout()).toContain('2 connected clients');
    expect(h.stdout()).toContain('sess-1  flutter (iPhone 17 Pro)  app session');
    expect(h.stdout()).toContain('sess-2  studio  as alice · tenant acme');
  });

  it('prints the raw result under --json', async () => {
    const result = {
      ok: true,
      summary: 'No clients are connected to this bridge.',
      data: { sessions: [], total: 0 },
    };
    const h = harness(result);

    expect(await runAuthSessions(parsed('auth', 'sessions', '--json'), h.deps)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual(result);
  });

  it('exits 1 with an actionable message when no bridge is running', async () => {
    const h = harness(OK);
    h.deps.discover = async () => null;

    expect(await runAuthSessions(parsed('auth', 'sessions'), h.deps)).toBe(1);
    expect(h.stderr()).toContain(NO_BRIDGE_CLI_MESSAGE);
    expect(h.calls).toEqual([]);
  });

  it('exits 2 when the bridge cannot be reached', async () => {
    const h = harness(OK);
    h.deps.callTool = async () => {
      throw new Error('socket hang up');
    };

    expect(await runAuthSessions(parsed('auth', 'sessions'), h.deps)).toBe(2);
    expect(h.stderr()).toContain('socket hang up');
  });
});

describe('pyric auth whoami', () => {
  it('prints the identity and the note that your own calls are unaffected', async () => {
    const h = harness({ ok: true, summary: 'You act as admin.', data: {} });

    expect(await runAuthWhoami(parsed('auth', 'whoami'), h.deps)).toBe(0);
    expect(h.calls).toEqual([{ tool: 'auth_whoami', args: {} }]);
    expect(h.stdout()).toContain('You act as admin.');
    expect(h.stdout()).toContain(SELF_SCOPE_NOTE);
  });
});

describe('pyric auth impersonate', () => {
  it('sends the uid and prints the self note when no target is given', async () => {
    const h = harness(OK);

    expect(await runAuthImpersonate(parsed('auth', 'impersonate', 'alice'), h.deps)).toBe(0);
    expect(h.calls).toEqual([{ tool: 'auth_impersonate', args: { uid: 'alice' } }]);
    expect(h.stdout()).toContain(SELF_SCOPE_NOTE);
    expect(h.stdout()).not.toContain(TARGET_SCOPE_NOTE);
  });

  it('sends uid, tenant, claims, and target, and prints the target note', async () => {
    const h = harness(OK);

    await runAuthImpersonate(
      parsed(
        'auth', 'impersonate', 'alice',
        '--tenant', 'tenant-acme',
        '--claims', '{"role":"editor"}',
        '--target', 'sess-1',
      ),
      h.deps,
    );

    expect(h.calls).toEqual([
      {
        tool: 'auth_impersonate',
        args: {
          uid: 'alice',
          tenant: 'tenant-acme',
          claims: { role: 'editor' },
          target: 'sess-1',
        },
      },
    ]);
    expect(h.stdout()).toContain(TARGET_SCOPE_NOTE);
  });

  it('sends admin and anonymous without extra fields', async () => {
    const admin = harness(OK);
    await runAuthImpersonate(parsed('auth', 'impersonate', '--admin'), admin.deps);
    expect(admin.calls).toEqual([{ tool: 'auth_impersonate', args: { admin: true } }]);

    const anonymous = harness(OK);
    await runAuthImpersonate(parsed('auth', 'impersonate', '--anonymous'), anonymous.deps);
    expect(anonymous.calls).toEqual([{ tool: 'auth_impersonate', args: { anonymous: true } }]);
  });

  it('exits 1 on a bad selector combination, before contacting a bridge', async () => {
    const h = harness(OK);

    expect(await runAuthImpersonate(parsed('auth', 'impersonate'), h.deps)).toBe(1);
    expect(h.stderr()).toContain('name a uid');
    expect(h.stderr()).toContain('pyric auth sessions');
    expect(h.calls).toEqual([]);
  });

  it('exits 2 when the bridge reports the target is unknown', async () => {
    const h = harness({
      ok: false,
      summary: 'No connected client has target id sess-9. Connected: sess-1.',
      data: { code: 'auth/unknown-session', connected: ['sess-1'] },
    });

    expect(
      await runAuthImpersonate(
        parsed('auth', 'impersonate', '--admin', '--target', 'sess-9'),
        h.deps,
      ),
    ).toBe(2);
    expect(h.stderr()).toContain('sess-9');
  });

  it('reports a failure as JSON with exit 2 under --json', async () => {
    const failure: AuthToolResult = {
      ok: false,
      summary: 'No connected client has target id sess-9. No clients are connected.',
      data: { code: 'auth/unknown-session', connected: [] },
    };
    const h = harness(failure);

    expect(
      await runAuthImpersonate(
        parsed('auth', 'impersonate', '--admin', '--target', 'sess-9', '--json'),
        h.deps,
      ),
    ).toBe(2);
    expect(JSON.parse(h.stdout())).toEqual(failure);
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
    await runAuthImpersonate(parsed('auth', 'impersonate', 'alice'), h.deps);
    expect(h.stdout()).toContain('applied to the tool calls you forward through it');
  });

  it('keeps saying a targeted call leaves your own tool calls alone', async () => {
    const phrase = 'does not change how your own tool calls are rules-evaluated';
    expect(TARGET_SCOPE_NOTE).toContain(phrase);

    const h = harness(OK);
    await runAuthImpersonate(parsed('auth', 'impersonate', 'alice', '--target', 'sess-1'), h.deps);
    expect(h.stdout()).toContain(phrase);
  });

  it('does not print the note twice when the bridge already said it', async () => {
    const h = harness({ ok: true, summary: `You now act as admin. ${SELF_SCOPE_NOTE}`, data: {} });

    await runAuthImpersonate(parsed('auth', 'impersonate', '--admin'), h.deps);
    expect(h.stdout().split(SELF_SCOPE_NOTE)).toHaveLength(2);
  });
});

describe('service command routing', () => {
  it('routes the two-word auth commands and rejects an unknown operation', async () => {
    let stderr = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await dispatchServiceCommand(parseArgs(['auth', 'lens']))).toBe(1);
    } finally {
      process.stderr.write = original;
    }
    expect(stderr).toBe("pyric: unknown command 'auth lens'.\n");
  });

  it('reaches the impersonate handler through the registry', async () => {
    const h = harness(OK);
    const argv = parseArgs(['auth', 'impersonate', 'alice']);
    // Mirrors dispatchServiceCommand's slice for a two-word path.
    expect(await runAuthImpersonate({ ...argv, positional: argv.positional.slice(1) }, h.deps)).toBe(0);
    expect(h.calls[0]!.args).toEqual({ uid: 'alice' });
  });
});
