import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { join } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { allocateFreeVitePort } from './free-vite-port.ts';

const netServers: NetServer[] = [];
const viteServers: ViteDevServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (viteServers.length > 0) {
    const server = viteServers.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
  while (netServers.length > 0) {
    const server = netServers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      removePrivateJobTmpDir(dir);
    }
  }
});

function occupyWildcardPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const blocker = createNetServer();
    blocker.once('error', reject);
    blocker.listen(0, '::', () => {
      netServers.push(blocker);
      const addr = blocker.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('expected numeric port on wildcard listener'));
        return;
      }
      resolvePort(addr.port);
    });
  });
}

describe('allocateFreeVitePort', () => {
  test('returns a free loopback port > 0 that avoids occupied wildcard listeners and serves Vite cleanly', async () => {
    const occupied = await occupyWildcardPort();
    const port = await allocateFreeVitePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(occupied);

    const root = createPrivateJobTmpDir('free-vite-port');
    tempDirs.push(root);
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>ok</title>');

    const server = await createViteServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port, strictPort: false, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    viteServers.push(server);
    await server.listen();
    const bound = server.httpServer?.address();
    if (bound === null || bound === undefined || typeof bound === 'string') {
      throw new Error('expected bound TCP port');
    }
    expect(bound.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${String(bound.port)}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ok</title>');
  });
});
