/**
 * The shared host resolver finds a project's host through its
 * `.pyric/serve.json`, and never port-scans: a scan hit is never attached
 * to, and a scan over ports that accept and never answer takes a second per
 * port. A process resolves again at each reconnect (#1219), so the scan
 * would spend the window its held calls wait in.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRemoteHost } from '../../src/remote/resolve-host.js';
import { SCAN_PORTS } from '../../src/serve/discovery.js';

/** Scan ports this test holds open with a listener that accepts and never answers, as a hung process does. */
const silent: Server[] = [];
const held = new Set<Socket>();

function holdSilently(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer((socket) => { held.add(socket); });
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      silent.push(server);
      resolve(true);
    });
  });
}

beforeAll(async () => {
  for (const port of SCAN_PORTS) await holdSilently(port);
});

afterAll(() => {
  for (const socket of held) socket.destroy();
  for (const server of silent) server.close();
});

it('reports no host at once in a project with no serve.json, without probing the scan ports', async () => {
  expect(silent.length).toBeGreaterThan(0);
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-resolve-host-'));
  const startedAt = performance.now();
  await expect(resolveRemoteHost({ cwd })).rejects.toMatchObject({ code: 'not-found' });
  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(held.size).toBe(0);
});

it('a stale PYRIC_SANDBOX url falls back to the project pointer without probing the scan ports either', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-resolve-host-'));
  const closed = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  await expect(resolveRemoteHost({ cwd, configuredUrl: `http://127.0.0.1:${closed}` })).rejects.toMatchObject({ code: 'not-found' });
  expect(held.size).toBe(0);
});
