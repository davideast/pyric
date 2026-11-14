/**
 * The e2e host wait against a stand-in host over real HTTP. The stand-in
 * answers health as a token-gated host does: the full body, with its `live`
 * report, to a request that carries its token, and the reduced body to any
 * other. It writes its pointer file only when the test says so, which is the
 * order a real host starts in: connected first, pointer after.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthOf, sessionHeaders, waitForHost, type HostProcess } from './host-health.js';

const TOKEN = 'stand-in-token';
const LIVE = { projectId: 'demo-project', billed: { reads: 0, writes: 0, deliveries: 0 } };

interface StandIn {
  url: string;
  root: string;
  process: HostProcess & { child: { exitCode: number | null } };
  /** The tokens of the health requests answered so far, `null` for a request without one. */
  seenTokens: Array<string | null>;
  sandboxConnected: boolean;
  publishPointer(token?: string): void;
}

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function standInHost(): Promise<StandIn> {
  const root = mkdtempSync(join(tmpdir(), 'host-health-'));
  roots.push(root);
  const host: StandIn = {
    url: '',
    root,
    process: { child: { exitCode: null }, output: () => 'stand-in output' },
    seenTokens: [],
    sandboxConnected: true,
    publishPointer(token = TOKEN) {
      mkdirSync(join(root, '.pyric'), { recursive: true });
      writeFileSync(join(root, '.pyric/serve.json'), JSON.stringify({ token }));
    },
  };
  const server = createServer((request, response) => {
    const header = request.headers['x-pyric-session-token'];
    let token: string | null = null;
    if (typeof header === 'string') token = header;
    host.seenTokens.push(token);
    const body: Record<string, unknown> = { status: 'ok', mode: 'sandbox', sandboxConnected: host.sandboxConnected };
    if (token === TOKEN) body.live = LIVE;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return host;
}

describe('waitForHost', () => {
  test('a host that is connected before it writes its pointer is read only once the pointer names its token', async () => {
    const host = await standInHost();
    // Connected, answering, and no pointer yet: the gap a real host leaves.
    const published = setTimeout(() => host.publishPointer(), 150);
    try {
      const health = await waitForHost(host.process, host.url, host.root, { pollMs: 5, timeoutMs: 5_000 });
      expect(health.live).toEqual(LIVE);
      // No request left without the token, so no reduced body was ever read as the host's health.
      expect(host.seenTokens.length).toBeGreaterThan(0);
      expect(host.seenTokens.every((token) => token === TOKEN)).toBe(true);
    } finally {
      clearTimeout(published);
    }
  });

  test('a host that never writes a pointer fails the wait, naming the missing token', async () => {
    const host = await standInHost();
    const wait = waitForHost(host.process, host.url, host.root, { pollMs: 5, timeoutMs: 100 });
    await expect(wait).rejects.toThrow('did not connect its sandbox (last: no session token in .pyric/serve.json)');
    expect(host.seenTokens).toEqual([]);
  });

  test('a pointer whose token the host does not accept gets the reduced body, and the wait still returns what the host answered', async () => {
    const host = await standInHost();
    host.publishPointer('another-token');
    const health = await waitForHost(host.process, host.url, host.root, { pollMs: 5, timeoutMs: 5_000 });
    // The caller's assertion on `live` then fails: the wait hides nothing.
    expect(health.live).toBeUndefined();
    expect(host.seenTokens).toEqual(['another-token']);
  });

  test('a host whose sandbox never connects fails the wait with its last health', async () => {
    const host = await standInHost();
    host.sandboxConnected = false;
    host.publishPointer();
    const wait = waitForHost(host.process, host.url, host.root, { pollMs: 5, timeoutMs: 100 });
    await expect(wait).rejects.toThrow('"sandboxConnected":false');
  });

  test('a host that exits fails the wait with its output', async () => {
    const host = await standInHost();
    host.process.child.exitCode = 1;
    const wait = waitForHost(host.process, host.url, host.root, { pollMs: 5, timeoutMs: 5_000 });
    await expect(wait).rejects.toThrow('the host exited:\nstand-in output');
  });
});

describe('healthOf and sessionHeaders', () => {
  test('healthOf makes no request while the pointer names no token', async () => {
    const host = await standInHost();
    expect(await healthOf(host.url, host.root)).toBeNull();
    mkdirSync(join(host.root, '.pyric'), { recursive: true });
    writeFileSync(join(host.root, '.pyric/serve.json'), '{"tok');
    expect(await healthOf(host.url, host.root)).toBeNull();
    expect(host.seenTokens).toEqual([]);
    host.publishPointer();
    expect((await healthOf(host.url, host.root))?.live).toEqual(LIVE);
  });

  test('sessionHeaders throws while the pointer names no token, and carries it after', async () => {
    const host = await standInHost();
    expect(() => sessionHeaders(host.root)).toThrow('has published no session token in .pyric/serve.json');
    host.publishPointer();
    expect(sessionHeaders(host.root)).toEqual({ 'x-pyric-session-token': TOKEN });
  });
});
