/**
 * #2098: `/__pyric/diagnostics` must keep answering 204 across Vite dev server
 * restarts -- both while the replacement server's `configureServer` awaits
 * config/generation startup on its new Connect stack and after the old
 * generation closes on the previous stack -- without weakening `#3130`-#3147
 * loopback, DNS-rebinding, origin, session-token, or 16 KiB body guards.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ViteDevServer } from 'vite';
import type { SandboxSession } from '../../src/serve/sandbox-session.js';
import { DIAGNOSTICS_PATH } from '../../src/serve/runtime/diagnostics-report.js';
import { attachViteGenerationMiddleware } from '../../src/serve/vite-generation-middleware.js';
import {
  attachVitePendingDiagnosticsMiddleware,
  type VitePendingDiagnosticsPolicy,
} from '../../src/serve/vite-pending-diagnostics.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { resolveNodeExecutable } from './require-node-on-path.js';
import { MockRes, type PyricMiddleware, type PyricReq } from './vite-plugin-harness.js';

const VALID_REPORT = JSON.stringify({
  version: 1,
  clientId: 'tab-restart-1',
  sequence: 1,
  realm: 'page',
  pageOrigin: 'http://localhost:5173',
  events: [
    {
      at: 10,
      phase: 'socket-close',
      connectionId: 'conn-1',
      endpoint: 'ws://localhost:5173/__pyric/sandbox',
      code: 1006,
    },
  ],
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createStackStub(host = 'localhost', allowedHosts: true | string[] = []) {
  const pyricHandlers: PyricMiddleware[] = [];
  const server = {
    async close() {},
    config: {
      root: '',
      logger: { info() {}, warn() {} },
      server: { host, allowedHosts },
    },
    middlewares: {
      stack: [] as Array<{ route: string; handle: PyricMiddleware }>,
      use(route: string | PyricMiddleware, fn?: PyricMiddleware) {
        if (typeof route === 'function') {
          pyricHandlers.push(route);
          this.stack.push({ route: '', handle: route });
          return;
        }
        if (route === '/__pyric' && fn) {
          pyricHandlers.push(fn);
          this.stack.push({ route, handle: fn });
        }
      },
    },
    watcher: { add() {}, on() {}, off() {} },
    httpServer: { address: () => ({ port: 5173 }), on() {}, once() {}, removeListener() {}, off() {} },
  };
  return {
    server: server as unknown as ViteDevServer,
    raw: server,
    pyricHandlers,
  };
}

function sendToStack(
  handlers: readonly PyricMiddleware[],
  opts: {
    method?: string;
    path?: string;
    host?: string;
    remoteAddress?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ statusCode: number; body: string; nexted: boolean }> {
  const path = opts.path ?? DIAGNOSTICS_PATH;
  const response = new MockRes();
  const stream = Readable.from(opts.body !== undefined ? [Buffer.from(opts.body, 'utf8')] : []);
  const req = Object.assign(stream, {
    method: opts.method ?? 'POST',
    url: path.startsWith('/__pyric') ? path.slice('/__pyric'.length) || '/' : path,
    originalUrl: path,
    headers: {
      host: opts.host ?? 'localhost:5173',
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    },
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1', localPort: 5173, end() {}, destroy() {} },
  }) as unknown as PyricReq;

  return new Promise((resolve, reject) => {
    response.on('finish', () => {
      resolve({ statusCode: response.statusCode, body: response.body, nexted: false });
    });
    response.on('error', reject);
    const step = (idx: number): void => {
      const current = handlers[idx];
      if (current === undefined) {
        resolve({ statusCode: 404, body: '', nexted: true });
        return;
      }
      current(req, response, () => step(idx + 1));
    };
    step(0);
  });
}

describe('Vite pending diagnostics middleware during restart (#2098)', () => {
  it('fails closed before policy resolves, answers 204 once resolved, and yields once live generation mounts', async () => {
    const stub = createStackStub('localhost', true);
    let policy: VitePendingDiagnosticsPolicy | undefined;
    attachVitePendingDiagnosticsMiddleware(stub.server, true, () => policy);

    // Non-diagnostics routes always pass through while pending.
    const nonDiag = await sendToStack(stub.pyricHandlers, {
      method: 'GET',
      path: '/__pyric/init.json',
    });
    expect(nonDiag.nexted).toBe(true);

    // Before `readPyricConfig` resolves policy, fails closed with 401 (never 404 or unguarded 204).
    const prePolicy = await sendToStack(stub.pyricHandlers, { body: VALID_REPORT });
    expect(prePolicy.nexted).toBe(false);
    expect(prePolicy.statusCode).toBe(401);

    // Once policy resolves with default local settings, loopback POST answers 204 and GET answers 200.
    policy = {
      sessionToken: 'boot-tok-123',
      requireSessionToken: false,
      allowedHosts: [],
    };
    const okPost = await sendToStack(stub.pyricHandlers, { body: VALID_REPORT });
    expect(okPost.nexted).toBe(false);
    expect(okPost.statusCode).toBe(204);

    const okGet = await sendToStack(stub.pyricHandlers, { method: 'GET' });
    expect(okGet.statusCode).toBe(200);
    expect(JSON.parse(okGet.body).server.mode).toBe('hosted');

    // Security invariants (#3130-#3147): DNS-rebinding Host, cross-origin Origin, Sec-Fetch-Site, >16 KiB body.
    const rebound = await sendToStack(stub.pyricHandlers, {
      host: 'evil.example:5173',
      body: VALID_REPORT,
    });
    expect(rebound.statusCode).toBe(403);

    const crossOrigin = await sendToStack(stub.pyricHandlers, {
      headers: { origin: 'http://localhost:9999' },
      body: VALID_REPORT,
    });
    expect(crossOrigin.statusCode).toBe(403);

    const crossSite = await sendToStack(stub.pyricHandlers, {
      headers: { 'sec-fetch-site': 'cross-site' },
      body: VALID_REPORT,
    });
    expect(crossSite.statusCode).toBe(403);

    const oversized = await sendToStack(stub.pyricHandlers, {
      body: JSON.stringify({ huge: 'a'.repeat(20_000) }),
    });
    expect(oversized.statusCode).toBe(413);

    // Under `requireSessionToken: true`, unauthenticated POST rejects with 401; token succeeds with 204.
    policy = {
      sessionToken: 'boot-tok-123',
      requireSessionToken: true,
      allowedHosts: [],
    };
    const missingToken = await sendToStack(stub.pyricHandlers, { body: VALID_REPORT });
    expect(missingToken.statusCode).toBe(401);

    const withToken = await sendToStack(stub.pyricHandlers, {
      headers: { 'x-pyric-session-token': 'boot-tok-123' },
      body: VALID_REPORT,
    });
    expect(withToken.statusCode).toBe(204);

    // Once the live generation mounts on the same stack, pending middleware yields to it.
    let liveHandled = 0;
    const session = {
      async handle(_req: unknown, res: MockRes): Promise<boolean> {
        liveHandled += 1;
        res.writeHead(204).end();
        return true;
      },
    } as unknown as SandboxSession;
    const disposeLive = attachViteGenerationMiddleware({
      server: stub.server,
      bridge: null,
      session,
    });
    const viaLive = await sendToStack(stub.pyricHandlers, { body: VALID_REPORT });
    expect(viaLive.statusCode).toBe(204);
    expect(liveHandled).toBe(1);
    disposeLive();
  });

  it('answers 204 on both old and replacement Connect stacks while configureServer is mid-restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-vite-diag-2098-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>');

    // Generation 1 boots completely.
    const gen1 = createStackStub();
    gen1.raw.config.root = dir;
    const plugin1 = pyric({ persist: true, ui: false });
    await (plugin1.configureServer as (server: ViteDevServer) => Promise<void>)(gen1.server);

    const beforeRestart = await sendToStack(gen1.pyricHandlers, { body: VALID_REPORT });
    expect(beforeRestart.statusCode).toBe(204);

    // Start Generation 2 (`configureServer` synchronously mounts pending diagnostics,
    // then awaits `readPyricConfig`, `slot.take()?.close()`, and `createViteSandboxGeneration`).
    const gen2 = createStackStub();
    gen2.raw.config.root = dir;
    const plugin2 = pyric({ persist: true, ui: false });
    const bootingGen2 = (plugin2.configureServer as (server: ViteDevServer) => Promise<void>)(
      gen2.server,
    );

    // Poll diagnostics across the async handoff window until Generation 2 finishes booting;
    // neither gen1 nor gen2 may ever fall through to 404 (`nexted: true`).
    let gen2Done = false;
    void bootingGen2.finally(() => {
      gen2Done = true;
    });
    let midFlightChecks = 0;
    while (!gen2Done) {
      const onOld = await sendToStack(gen1.pyricHandlers, { body: VALID_REPORT });
      expect(onOld.nexted).toBe(false);
      expect([204, 401]).toContain(onOld.statusCode);

      const onNew = await sendToStack(gen2.pyricHandlers, { body: VALID_REPORT });
      expect(onNew.nexted).toBe(false);
      expect([204, 401]).toContain(onNew.statusCode);
      midFlightChecks += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await bootingGen2;
    expect(midFlightChecks).toBeGreaterThan(0);

    // After Generation 2 finishes, old stack (now inactive) and new stack both answer 204!
    const oldAfterClose = await sendToStack(gen1.pyricHandlers, { body: VALID_REPORT });
    expect(oldAfterClose.nexted).toBe(false);
    expect(oldAfterClose.statusCode).toBe(204);

    const newAfterBoot = await sendToStack(gen2.pyricHandlers, { body: VALID_REPORT });
    expect(newAfterBoot.nexted).toBe(false);
    expect(newAfterBoot.statusCode).toBe(204);

    await gen2.server.close();
    await gen1.server.close();
  }, 45_000);

  it('never returns 404 on live HTTP POST /__pyric/diagnostics across a hosted Vite server.restart()', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-hosted-diag-2098-')));
    tempDirs.push(parent);
    const root = join(parent, 'app');
    mkdirSync(root);
    symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
    writeFileSync(join(root, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-app' } }));
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body></body></html>');
    writeFileSync(
      join(root, 'vite.config.mjs'),
      "import { pyric } from '@pyric/cli/vite';\nexport default { plugins: [pyric({ hosted: true, ui: false })] };\n",
    );

    const nodeBin = resolveNodeExecutable();
    const script = new URL('./fixtures/vite-restart-diagnostics-host.mjs', import.meta.url).pathname;
    const result = spawnSync(nodeBin, [script, root], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      replacedInstance: boolean;
      statuses: number[];
    };
    expect(report.replacedInstance).toBe(true);
    expect(report.statuses.length).toBeGreaterThan(5);
    expect(report.statuses.every((code) => code === 204), JSON.stringify(report.statuses)).toBe(true);
  }, 75_000);
});
