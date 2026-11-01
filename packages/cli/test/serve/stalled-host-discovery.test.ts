/**
 * A host whose process is alive but whose event loop stalls past the health
 * probe's one-second deadline is still the project's host. `.pyric/serve.json`
 * names its port and a live pid, so a Node process started during the stall
 * waits for it instead of calling `PYRIC_SANDBOX=remote:<url>` stale (#1527).
 *
 * The stalled host here is a real HTTP server that holds every health
 * response until the stall ends, as a paused Vite dev server does: the kernel
 * accepts the connection and nothing answers until the process runs again.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverServe, selectExplicitHost } from '../../src/serve/discovery.js';
import { closedPort } from '../closed-port.js';

const INSTANCE_ID = 'stalled-host-instance';

interface StalledHost {
  port: number;
  /** Hold every health response for `ms` from now. */
  stallFor(ms: number): void;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function stalledHost(instanceId = INSTANCE_ID): Promise<StalledHost> {
  let stallEndsAt = 0;
  const server = createServer((req, res) => {
    const answer = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'sandbox', instanceId }));
    };
    setTimeout(answer, Math.max(0, stallEndsAt - Date.now()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    stallFor(ms) { stallEndsAt = Date.now() + ms; },
  };
}

function projectWithPointer(pointer: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-stalled-host-'));
  mkdirSync(join(cwd, '.pyric'));
  writeFileSync(join(cwd, '.pyric', 'serve.json'), JSON.stringify(pointer));
  return cwd;
}

function pointerFor(port: number, pid: number, instanceId = INSTANCE_ID): Record<string, unknown> {
  return { url: `http://127.0.0.1:${port}`, mcpUrl: `http://127.0.0.1:${port}/__pyric/mcp`, port, pid, instanceId };
}

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

const noScan: number[] = [];

describe('a live host that stalls past the health deadline', () => {
  it('is the url PYRIC_SANDBOX names, not a stale one', async () => {
    const host = await stalledHost();
    const cwd = projectWithPointer(pointerFor(host.port, process.pid));
    host.stallFor(2_200);

    const choice = await selectExplicitHost({ url: `http://127.0.0.1:${host.port}`, cwd });

    expect(choice).toEqual({ kind: 'explicit', serveUrl: `http://127.0.0.1:${host.port}`, base: `http://127.0.0.1:${host.port}` });
  }, 15_000);

  it('is found through the pointer once it answers', async () => {
    const host = await stalledHost();
    const cwd = projectWithPointer(pointerFor(host.port, process.pid));
    host.stallFor(2_200);

    const found = await discoverServe(cwd, undefined, noScan);

    expect(found?.instanceId).toBe(INSTANCE_ID);
  }, 15_000);
});

describe('a pointer that names no live host', () => {
  it('fails at once when the pointer\'s process has exited', async () => {
    const port = await closedPort();
    const cwd = projectWithPointer(pointerFor(port, exitedPid()));
    const started = Date.now();

    const choice = await selectExplicitHost({ url: `http://127.0.0.1:${port}`, cwd });

    expect(choice.kind).toBe('stale');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('fails at once when another host answers on the pointer\'s port', async () => {
    const squatter = await stalledHost('another-host');
    const cwd = projectWithPointer(pointerFor(squatter.port, process.pid));
    const started = Date.now();

    const found = await discoverServe(cwd, undefined, noScan);

    expect(found).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
