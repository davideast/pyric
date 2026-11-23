/**
 * Focused regression tests for issue #1076:
 * 1. `watchFunctionsSourceDirectory` attaches directory watches synchronously
 *    and delivers both immediate post-attach saves and sub-millisecond second
 *    saves without Chokidar's async `readdirp` startup window or 50 ms
 *    `EV_CHANGE` / coarse `mtimeMs` drop.
 * 2. `connectFunctionsWorkerPeer(...).close()` terminates promptly instead of
 *    stalling 30 s on `ws._closeTimer` when a server withholds a close frame.
 */
import 'fake-indexeddb/auto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import { watchFunctionsSourceDirectory, type FunctionsSourceWatch } from '../../src/serve/functions-source-watch.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const tempDirs = trackTempDirs('pyric-1076-watch-');
let activeWatch: FunctionsSourceWatch | undefined;
let activeHttpServer: Server | undefined;
let activeWss: WebSocketServer | undefined;

async function waitForCount(
  read: () => number,
  expectedAtLeast: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read() >= expectedAtLeast) return;
    await Bun.sleep(10);
  }
  throw new Error(`expected at least ${expectedAtLeast} watch events, observed ${read()}`);
}

afterEach(async () => {
  activeWatch?.close();
  activeWatch = undefined;
  if (activeWss !== undefined) {
    for (const client of activeWss.clients) {
      client.terminate();
    }
    activeWss.close();
    activeWss = undefined;
  }
  if (activeHttpServer !== undefined) {
    const srv = activeHttpServer;
    activeHttpServer = undefined;
    srv.closeAllConnections();
    await new Promise<void>((resolveClosed) => {
      srv.close(() => resolveClosed());
    });
  }
  tempDirs.cleanupTempDirs();
});

describe('#1076 functions source watch & worker-peer close bounds', () => {
  test('delivers immediate post-attach and rapid consecutive saves across 25 iterations while ignoring node_modules', async () => {
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const root = tempDirs.makeTempDir('pyric-1076-watch-');
      const sourceDir = join(root, 'functions');
      const nestedDir = join(sourceDir, 'lib');
      const ignoredDir = join(sourceDir, 'node_modules', 'pkg');
      mkdirSync(nestedDir, { recursive: true });
      mkdirSync(ignoredDir, { recursive: true });
      const entry = join(sourceDir, 'index.cjs');
      const helper = join(nestedDir, 'handler.cjs');
      writeFileSync(entry, 'module.exports = 1;\n');
      writeFileSync(helper, 'module.exports = 1;\n');

      const seen: string[] = [];
      const watcher = watchFunctionsSourceDirectory(sourceDir, (changedPath) => {
        seen.push(changedPath);
      });
      activeWatch = watcher;

      // Save 1 immediately on the synchronous return tick after watch attach.
      writeFileSync(entry, 'module.exports = 2;\n');
      await waitForCount(() => seen.length, 1);

      // Save 2 to the SAME file immediately after Save 1 settles (verifies no
      // per-file watcher was leaked onto `entry` that would emit `entry/index.cjs`).
      const beforeSecondSameFile = seen.length;
      writeFileSync(entry, 'module.exports = 3;\n');
      await waitForCount(() => seen.length, beforeSecondSameFile + 1);

      // Save 3 to a nested subdirectory file inside Chokidar's 50 ms throttle window.
      const beforeNested = seen.length;
      writeFileSync(helper, 'module.exports = 4;\n');
      await waitForCount(() => seen.length, beforeNested + 1);

      expect(seen.every((observed) => observed === entry || observed === helper)).toBe(true);

      // Ignored `node_modules` writes must never emit source reload events.
      const beforeIgnored = seen.length;
      writeFileSync(join(ignoredDir, 'index.js'), 'module.exports = 99;\n');
      await Bun.sleep(25);
      expect(seen.length).toBe(beforeIgnored);

      watcher.close();
      activeWatch = undefined;
    }
  }, 30_000);

  test('connectFunctionsWorkerPeer.close() resolves well under 2s when server socket withholds close echo', async () => {
    const httpServer = createServer();
    activeHttpServer = httpServer;
    const wss = new WebSocketServer({ server: httpServer });
    activeWss = wss;

    wss.on('connection', (socket, req) => {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as { type?: string };
        if (parsed.type === 'hello') {
          socket.send(
            JSON.stringify({
              type: 'hello-ack',
              protocol: 1,
              project: 'demo-project',
              instanceId: 'host-1076',
            }),
          );
          // Pause the underlying TCP socket so incoming client close frames are
          // never echoed back -- reproducing a wedged close handshake in afterEach.
          req.socket.pause();
        }
      });
    });

    await new Promise<void>((resolveListening) => {
      httpServer.listen(0, '127.0.0.1', () => resolveListening());
    });
    const addr = httpServer.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'peer-1076',
      instanceId: 'peer-1076',
    });
    const peer = await connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${port}/__pyric/sandbox`,
      ctx,
      sandboxId: 'peer-1076-client',
      sessionToken: 'test-token',
    });

    const start = performance.now();
    await peer.close();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1_500);
  });
});
