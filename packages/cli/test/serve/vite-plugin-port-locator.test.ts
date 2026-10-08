/**
 * When the requested Vite port is taken, Vite listens on the next free one.
 * The `.pyric/serve.json` locator must record the port Vite actually took, so
 * `PYRIC_SANDBOX=remote` finds the host whatever port it landed on.
 *
 * Vite runs on Node (its supported host) with the built plugin; the test
 * holds the requested port first so Vite has to move. Build the CLI first.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverServe, selectProjectHost } from '../../src/serve/discovery.js';
import { startViteNodeHost, type ViteNodeHost } from './vite-node-host.js';

let host: ViteNodeHost | undefined;
let blocker: NetServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
  blocker = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** Hold a free port on the address Vite will bind, so Vite must move past it. */
async function holdFreePort(): Promise<{ port: number; server: NetServer }> {
  const held = createNetServer();
  await new Promise<void>((resolve, reject) => {
    held.once('error', reject);
    held.listen(0, '127.0.0.1', () => resolve());
  });
  const address = held.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return { port, server: held };
}

describe('Vite plugin locator when Vite moves to another port', () => {
  it('records the port Vite listens on, and discovery finds the host there', async () => {
    root = mkdtempSync(join(tmpdir(), 'pyric-vite-port-locator-'));
    const held = await holdFreePort();
    blocker = held.server;

    host = await startViteNodeHost(root, { port: held.port, host: '127.0.0.1' });
    expect(host.port).not.toBe(held.port);
    expect(host.port).toBeGreaterThan(0);

    const pointer = JSON.parse(readFileSync(join(root, '.pyric', 'serve.json'), 'utf8')) as {
      port: number;
      url: string;
    };
    expect(pointer.port).toBe(host.port);
    expect(pointer.url).toBe(`http://127.0.0.1:${host.port}`);

    const found = selectProjectHost(await discoverServe(root, () => {}, []), () => {});
    expect(found?.url).toBe(`http://127.0.0.1:${host.port}`);
    expect(found?.base).toBe(`http://127.0.0.1:${host.port}`);
  }, 60_000);
});
