/**
 * Only the project's own `.pyric/serve.json` pointer selects a sandbox host.
 * A server found by the port scan may belong to another project, so the
 * commands that attach to a host refuse it and say so.
 */
import { describe, expect, it } from 'bun:test';
import { runBridgeCommand } from '../../src/cli/bridge-tool-call.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { selectProjectHost, type Discovered } from '../../src/serve/discovery.js';
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
