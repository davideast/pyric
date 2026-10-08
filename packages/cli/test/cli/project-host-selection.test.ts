/**
 * Only the project's own `.pyric/serve.json` pointer selects a sandbox host.
 * A server found by the port scan may belong to another project, so the
 * commands that attach to a host refuse it and say so.
 */
import { describe, expect, it } from 'bun:test';
import { runBridgeCommand } from '../../src/cli/bridge-tool-call.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { selectExplicitHost, selectProjectHost, type Discovered } from '../../src/serve/discovery.js';
import { connectRemoteSandbox } from '../../src/remote/index.js';

function sandbox(port: number, source: string, pointerProjectDir?: string): Discovered {
  return {
    pointerProjectDir,
    mcpUrl: `http://127.0.0.1:${port}/__pyric/mcp`,
    url: `http://localhost:${port}`,
    base: `http://127.0.0.1:${port}`,
    instanceId: `instance-${port}`,
    source,
  };
}

const mine = sandbox(5192, 'pointer /workspace/app/.pyric/serve.json', '/workspace/app');
const otherProjectsScanHit = sandbox(3473, 'port scan (:3473)');

describe('selectProjectHost', () => {
  it('returns a host found through the pointer', () => {
    expect(selectProjectHost(mine, () => {})).toBe(mine);
  });

  it('returns null and logs when only the port scan found a server', () => {
    const logged: string[] = [];
    expect(selectProjectHost(otherProjectsScanHit, (m) => logged.push(m))).toBeNull();
    expect(logged.join('\n')).toContain('port scan (:3473)');
    expect(logged.join('\n')).toContain('not attached to');
  });

  it('returns null without logging when nothing was found', () => {
    const logged: string[] = [];
    expect(selectProjectHost(null, (m) => logged.push(m))).toBeNull();
    expect(logged).toEqual([]);
  });
});

describe('a bridge command when the scan finds another project\'s sandbox', () => {
  it('does not call the scanned sandbox and reports why', async () => {
    const stderr: string[] = [];
    const calledUrls: string[] = [];
    const code = await runBridgeCommand(
      'auth sessions',
      'auth_sessions',
      {},
      parseArgs(['auth', 'sessions']),
      {
        cwd: '/workspace',
        stdout: { write() {} },
        stderr: { write: (s) => void stderr.push(s) },
        discover: async () => otherProjectsScanHit,
        callTool: async (url) => {
          calledUrls.push(url);
          return { ok: true, summary: 'ok' };
        },
      },
      () => {},
    );
    expect(code).toBe(1);
    expect(calledUrls).toEqual([]);
    expect(stderr.join('')).toContain('port scan (:3473)');
  });

  it('calls the sandbox the pointer names', async () => {
    const calledUrls: string[] = [];
    const code = await runBridgeCommand(
      'auth sessions',
      'auth_sessions',
      {},
      parseArgs(['auth', 'sessions']),
      {
        cwd: '/workspace/app',
        stdout: { write() {} },
        stderr: { write() {} },
        discover: async () => mine,
        callTool: async (url) => {
          calledUrls.push(url);
          return { ok: true, summary: 'ok' };
        },
      },
      () => {},
    );
    expect(code).toBe(0);
    expect(calledUrls).toEqual([mine.mcpUrl]);
  });
});

describe('connectRemoteSandbox when the scan finds another project\'s sandbox', () => {
  it('rejects as not found instead of connecting to the scanned sandbox', async () => {
    await expect(
      connectRemoteSandbox({ cwd: '/workspace', discover: async () => otherProjectsScanHit }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('selectExplicitHost: PYRIC_SANDBOX=remote:<url>', () => {
  const answering = (base: string, instanceId: string) => async () => ({ base, instanceId });
  const nothingAnswers = async () => null;

  it('uses the url when it answers as the host this project\'s pointer names', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:5192',
      cwd: '/workspace/app',
      discover: async () => mine,
      probe: answering('http://127.0.0.1:5192', 'instance-5192'),
    });
    expect(choice).toEqual({ kind: 'explicit', serveUrl: 'http://localhost:5192', base: 'http://127.0.0.1:5192' });
  });

  it('uses the url when it answers as the host the launcher pinned, with no pointer', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:4100/',
      cwd: '/elsewhere',
      launcherInstanceId: 'launcher-host',
      discover: async () => null,
      probe: answering('http://127.0.0.1:4100', 'launcher-host'),
    });
    expect(choice).toEqual({ kind: 'explicit', serveUrl: 'http://localhost:4100', base: 'http://127.0.0.1:4100' });
  });

  it('falls back to this project\'s host when nothing answers at the url', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:5173',
      cwd: '/workspace/app',
      discover: async () => mine,
      probe: nothingAnswers,
    });
    expect(choice.kind).toBe('project');
    if (choice.kind !== 'project') throw new Error('unreachable');
    expect(choice.host).toBe(mine);
    expect(choice.notice).toContain('PYRIC_SANDBOX=remote:http://localhost:5173');
    expect(choice.notice).toContain('nothing answers');
    expect(choice.notice).toContain(mine.url);
    expect(choice.notice).toContain('Set PYRIC_SANDBOX=remote');
  });

  it('falls back to this project\'s host when another host answers at the url', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:3473',
      cwd: '/workspace/app',
      discover: async () => mine,
      probe: answering('http://127.0.0.1:3473', 'another-projects-host'),
    });
    expect(choice.kind).toBe('project');
    if (choice.kind !== 'project') throw new Error('unreachable');
    expect(choice.host).toBe(mine);
    expect(choice.notice).toContain('not the host this project');
  });

  it('reports a stale url when nothing answers and this project has no running host', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:5173',
      cwd: '/workspace/app',
      discover: async () => null,
      probe: nothingAnswers,
    });
    expect(choice.kind).toBe('stale');
    if (choice.kind !== 'stale') throw new Error('unreachable');
    expect(choice.message).toContain('PYRIC_SANDBOX=remote:http://localhost:5173 is stale');
    expect(choice.message).toContain('nothing answers');
    expect(choice.message).toContain('Set PYRIC_SANDBOX=remote');
  });

  it('refuses a url that answers when no pointer in this project names that host', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:3473',
      cwd: '/workspace',
      discover: async () => otherProjectsScanHit,
      probe: answering('http://127.0.0.1:3473', 'instance-3473'),
    });
    expect(choice.kind).toBe('refused');
    if (choice.kind !== 'refused') throw new Error('unreachable');
    expect(choice.message).toContain('PYRIC_SANDBOX=remote:http://localhost:3473');
    expect(choice.message).toContain('another project');
    expect(choice.message).toContain('not attached to');
  });

  it('does not accept a launcher pin from a host that answers with a different identity', async () => {
    const choice = await selectExplicitHost({
      url: 'http://localhost:3473',
      cwd: '/workspace',
      launcherInstanceId: 'launcher-host',
      discover: async () => null,
      probe: answering('http://127.0.0.1:3473', 'some-other-host'),
    });
    expect(choice.kind).toBe('refused');
  });
});

describe('connectRemoteSandbox with a configured url', () => {
  it('takes a programmatic url as given, without discovery or a probe', async () => {
    let consulted = false;
    await expect(
      connectRemoteSandbox({
        url: 'http://127.0.0.1:1',
        cwd: '/workspace',
        discover: async () => { consulted = true; return null; },
        probe: async () => { consulted = true; return null; },
      }),
    ).rejects.toThrow(/failed to connect|timed out/);
    expect(consulted).toBe(false);
  });

  it('rejects a stale url with no running host for this project as not-found', async () => {
    await expect(
      connectRemoteSandbox({
        configuredUrl: 'http://127.0.0.1:1',
        cwd: '/workspace',
        discover: async () => null,
        probe: async () => null,
      }),
    ).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('is stale'),
    });
  });

  it('rejects a url that answers for another project as failed-precondition', async () => {
    await expect(
      connectRemoteSandbox({
        configuredUrl: 'http://localhost:3473',
        cwd: '/workspace',
        discover: async () => otherProjectsScanHit,
        probe: async () => ({ base: 'http://127.0.0.1:3473', instanceId: 'instance-3473' }),
      }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('warns once per url when it falls back to this project\'s host', async () => {
    const warnings: string[] = [];
    // The fallback host is a closed port, so the attach itself fails; the
    // warning is what this test observes.
    const closedHost = { ...mine, base: 'http://127.0.0.1:1', url: 'http://localhost:1' };
    const attempt = () =>
      connectRemoteSandbox({
        configuredUrl: 'http://localhost:59173',
        cwd: '/workspace/app',
        discover: async () => closedHost,
        probe: async () => null,
        warn: (m) => warnings.push(m),
      }).catch(() => undefined);
    await attempt();
    await attempt();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PYRIC_SANDBOX=remote:http://localhost:59173');
  });
});
