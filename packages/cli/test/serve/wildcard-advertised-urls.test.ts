/**
 * Enumeration standing check for wildcard bind addresses (`0.0.0.0`, `::`, `[::]`).
 *
 * Every client-facing URL advertised by a wildcard-bound host on either plane
 * (`.pyric/serve.json` `url` and `mcpUrl`, `/__pyric/init.json` `bridgeUrl`,
 * `--json` output, and every URL printed in the banner) must use a connectable
 * loopback hostname accepted by the host's own Host guard, while the Host guard
 * continues to reject wildcard `Host` headers with HTTP 403 and `pyric run`
 * explains a 403 Host-guard refusal accurately.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { startServe, serveJsonLine, type ServeRuntime } from '../../src/cli/serve.js';
import { formatStartupEnvExport } from '../../src/cli/sandbox-runner.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { resolveNodeExecutable } from './require-node-on-path.js';
import { createSandboxSession } from '../../src/serve/sandbox-session.js';
import { createViteSandboxGeneration } from '../../src/serve/vite-sandbox-generation.js';
import { isAllowedHost, type ServeLogger } from '../../src/serve/server.js';
import { CLI_ENTRY, runDispatch } from '../cli/run-cli.js';

interface HttpReply {
  status: number;
  body: string;
}

const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::', '[::]', '::0', '[::0]', '0']);

const tempDirs: string[] = [];
const activeStops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of activeStops.splice(0).reverse()) {
    await stop().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-wildcard-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>items</body></html>');
  return dir;
}

function makeUnrelatedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-outside-'));
  tempDirs.push(dir);
  return dir;
}

function runCommandAsync(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function httpGet(connectHost: string, port: number, path: string, hostHeader: string): Promise<HttpReply> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: connectHost, port, path, headers: { host: hostHeader } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', (error: Error) => {
      resolve({ status: 0, body: error.message });
    });
    req.end();
  });
}

function extractUrls(text: string): string[] {
  const matches = text.match(/(?:https?|wss?):\/\/[^\s`'",)]+/g);
  if (!matches) return [];
  return matches.map((entry) => entry.replace(/[.;:]+$/, ''));
}

async function canBindIpv6Wildcard(): Promise<boolean> {
  const probe = createServer();
  return new Promise<boolean>((resolve) => {
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, '::', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(filePath, 'utf8');
      return true;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  return false;
}

function assertConnectableAdvertisedUrl(rawUrl: string, label: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(`Advertised URL (${label}) is not a valid URL: ${rawUrl} (${String(error)})`);
  }
  expect(WILDCARD_HOSTNAMES.has(parsed.hostname.toLowerCase()), `${label}: ${rawUrl}`).toBe(false);
  expect(parsed.hostname, `${label}: ${rawUrl}`).toBe('localhost');
  expect(Number(parsed.port), `${label}: ${rawUrl}`).toBe(expectedPort);
  return parsed;
}

async function assertHostAcceptsAdvertisedUrl(
  rawUrl: string,
  label: string,
  connectHost: string,
  port: number,
): Promise<void> {
  const parsed = assertConnectableAdvertisedUrl(rawUrl, label, port);
  let path = parsed.pathname || '/';
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    path = '/__pyric/health';
  }
  const reply = await httpGet(connectHost, port, path, parsed.host);
  expect(reply.status, `${label} (${rawUrl}) should not be refused by Host guard`).not.toBe(0);
  expect(reply.status, `${label} (${rawUrl}) should not be refused with 403`).not.toBe(403);
}

describe('wildcard bind hosts advertise connectable loopback URLs', () => {
  it('CLI plane: every advertised URL for 0.0.0.0 (and :: when available) is accepted by the Host guard and works with pyric run', async () => {
    const bindCases: Array<{ bindHost: string; connectHost: string; wildcardHeaderHost: string }> = [
      { bindHost: '0.0.0.0', connectHost: '127.0.0.1', wildcardHeaderHost: '0.0.0.0' },
    ];
    if (await canBindIpv6Wildcard()) {
      bindCases.push(
        { bindHost: '::', connectHost: '::1', wildcardHeaderHost: '[::]' },
        { bindHost: '[::]', connectHost: '::1', wildcardHeaderHost: '[::]' },
      );
    }

    for (const testCase of bindCases) {
      const cwd = makeTempProject();
      const bannerLines: string[] = [];
      const logger: ServeLogger = {
        info: (message) => {
          bannerLines.push(message);
        },
        note: (message) => {
          bannerLines.push(message);
        },
      };

      const runtime: ServeRuntime = await startServe({
        cwd,
        port: 0,
        host: testCase.bindHost,
        cacheRoot: join(cwd, '.cache'),
        bridge: true,
        ui: true,
        disableAuditLog: true,
        logger,
      });
      activeStops.push(() => runtime.handle.stop());

      const port = runtime.handle.port;
      const startupExport = formatStartupEnvExport({
        serveUrl: runtime.handle.url,
        registerUrl: 'file:///register.js',
      });
      const fullBanner = `${bannerLines.join('\n')}\n${startupExport}`;

      const pointerPath = join(cwd, '.pyric', 'serve.json');
      expect(await waitForFile(pointerPath)).toBe(true);
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        url: string;
        mcpUrl: string;
      };

      const initReply = await httpGet(testCase.connectHost, port, '/__pyric/init.json', `localhost:${port}`);
      expect(initReply.status).toBe(200);
      const initBody = JSON.parse(initReply.body) as { bridgeUrl: string | null };
      expect(typeof initBody.bridgeUrl).toBe('string');

      const jsonLine = JSON.parse(serveJsonLine(runtime)) as {
        url: string;
        mcpUrl: string | null;
        uiUrl: string | null;
      };

      const advertised: Array<{ label: string; url: string }> = [
        { label: `${testCase.bindHost} handle.url`, url: runtime.handle.url },
        { label: `${testCase.bindHost} serve.json url`, url: pointer.url },
        { label: `${testCase.bindHost} serve.json mcpUrl`, url: pointer.mcpUrl },
        { label: `${testCase.bindHost} init.json bridgeUrl`, url: String(initBody.bridgeUrl) },
        { label: `${testCase.bindHost} --json url`, url: jsonLine.url },
      ];
      if (jsonLine.mcpUrl !== null) {
        advertised.push({ label: `${testCase.bindHost} --json mcpUrl`, url: jsonLine.mcpUrl });
      }
      if (jsonLine.uiUrl !== null) {
        advertised.push({ label: `${testCase.bindHost} --json uiUrl`, url: jsonLine.uiUrl });
      }

      const bannerUrls = extractUrls(fullBanner).filter((entry) => !entry.startsWith('file://'));
      const hostBannerUrls: string[] = [];
      for (const bannerUrl of bannerUrls) {
        const parsed = new URL(bannerUrl);
        expect(WILDCARD_HOSTNAMES.has(parsed.hostname.toLowerCase()), `${testCase.bindHost} banner: ${bannerUrl}`).toBe(
          false,
        );
        if (Number(parsed.port) === port) {
          hostBannerUrls.push(bannerUrl);
          advertised.push({ label: `${testCase.bindHost} banner`, url: bannerUrl });
        }
      }
      expect(hostBannerUrls.length).toBeGreaterThanOrEqual(3);

      for (const item of advertised) {
        await assertHostAcceptsAdvertisedUrl(item.url, item.label, testCase.connectHost, port);
      }

      // Security invariant: the host's own Host guard must still reject wildcard Host headers.
      const wildcardHealth = await httpGet(
        testCase.connectHost,
        port,
        '/__pyric/health',
        `${testCase.wildcardHeaderHost}:${port}`,
      );
      expect(wildcardHealth.status).toBe(403);

      // Banner cross-directory guidance must not recommend broken bare PYRIC_SANDBOX=remote:<url>.
      expect(startupExport).not.toContain('PYRIC_SANDBOX=remote:');
      expect(startupExport).toContain(`pyric run --sandbox ${pointer.url} -- <command>`);

      // Running the advertised URL via `pyric run --sandbox` succeeds from the project dir
      // and from an unrelated directory outside the project.
      const nodeBin = resolveNodeExecutable();
      const outsideDir = makeUnrelatedDir();
      for (const runCwd of [cwd, outsideDir]) {
        const result = await runCommandAsync(
          'bun',
          [
            CLI_ENTRY,
            'run',
            '--sandbox',
            pointer.url,
            '--',
            nodeBin,
            '-e',
            'if (!process.env.PYRIC_SANDBOX_INSTANCE) process.exit(3);',
          ],
          runCwd,
        );
        expect(result.status, `pyric run from ${runCwd}: ${result.stderr}`).toBe(0);
      }

      // Passing the wildcard URL directly to `pyric run --sandbox` gets a clear 403 Host-guard message.
      const wildcardUrl = `http://${testCase.wildcardHeaderHost}:${port}`;
      const started = Date.now();
      const refused = await runDispatch([
        'run',
        '--sandbox',
        wildcardUrl,
        '--wait=5',
        '--',
        'node',
        '-e',
        '0',
      ]);
      expect(refused.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(refused.stderr).toContain('403');
      expect(refused.stderr.toLowerCase()).toContain('host');
      expect(refused.stderr).not.toContain('not a sandbox host');
      expect(refused.stderr).toContain(`http://localhost:${port}`);
    }
  }, 60_000);

  it('Vite plane: serve.json url/mcpUrl and init.json bridgeUrl advertise localhost for 0.0.0.0 and ::', async () => {
    const bindCases: Array<{
      configuredHost: string;
      listenHost: string;
      connectHost: string;
      wildcardHeaderHost: string;
    }> = [
      { configuredHost: '0.0.0.0', listenHost: '0.0.0.0', connectHost: '127.0.0.1', wildcardHeaderHost: '0.0.0.0' },
    ];
    if (await canBindIpv6Wildcard()) {
      bindCases.push(
        { configuredHost: '::', listenHost: '::', connectHost: '::1', wildcardHeaderHost: '[::]' },
        { configuredHost: '[::]', listenHost: '::', connectHost: '::1', wildcardHeaderHost: '[::]' },
      );
    }

    for (const testCase of bindCases) {
      const cwd = makeTempProject();
      let pyricMiddleware:
        | ((req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => void)
        | null = null;

      const httpServer: Server = createServer((req, res) => {
        if (!isAllowedHost(req.headers.host, testCase.configuredHost, [])) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked request. Host is not allowed.');
          return;
        }
        const rawUrl = req.url ?? '/';
        if (pyricMiddleware !== null && rawUrl.startsWith('/__pyric')) {
          const rewritten = req as IncomingMessage & { originalUrl?: string };
          rewritten.originalUrl = rawUrl;
          rewritten.url = rawUrl.slice('/__pyric'.length) || '/';
          pyricMiddleware(rewritten, res, () => {
            if (!res.headersSent) res.writeHead(404).end();
          });
          return;
        }
        res.writeHead(404).end();
      });

      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, testCase.listenHost, () => {
          resolve();
        });
      });
      activeStops.push(
        () =>
          new Promise<void>((resolve) => {
            httpServer.close(() => {
              resolve();
            });
            httpServer.closeAllConnections?.();
          }),
      );

      const address = httpServer.address() as AddressInfo;
      const port = address.port;
      const watcher = new EventEmitter() as EventEmitter & { add(path: string | readonly string[]): void };
      watcher.add = () => {};

      const viteServerStub = {
        config: {
          root: cwd,
          server: { host: testCase.configuredHost, allowedHosts: [] as string[] },
          logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
          },
        },
        middlewares: {
          use(
            route: string,
            handler: (
              req: IncomingMessage & { originalUrl?: string },
              res: ServerResponse,
              next: () => void,
            ) => void,
          ) {
            if (route === '/__pyric') pyricMiddleware = handler;
          },
        },
        watcher,
        httpServer,
      };

      const generation = await createViteSandboxGeneration(
        {
          server: viteServerStub as unknown as ViteDevServer,
          projectDir: cwd,
          cliRoot: join(import.meta.dir, '..', '..'),
          workerRuntime: {
            prepare: async () => {},
            status: () => ({ sdkDir: join(cwd, '.sdk'), ready: true, epoch: 'v1' }),
            headTag: () => '',
          },
          options: {
            rules: undefined,
            seed: undefined,
            persist: undefined,
            fresh: undefined,
            capture: undefined,
            bridge: { disableAuditLog: true },
            ui: false,
            functions: false,
            avatars: undefined,
          },
          ai: { mode: 'sandbox', engineWire: undefined, proxyUpstream: undefined },
        },
        {
          createBridge: createBridgeMount,
          createSession: createSandboxSession,
          prepareWorker: async () => {},
          workerStatus: () => ({ sdkDir: join(cwd, '.sdk'), ready: true, epoch: 'v1' }),
          discoverFunctionsProject: () => null,
        },
      );
      activeStops.push(() => generation.close());

      const pointerPath = join(cwd, '.pyric', 'serve.json');
      expect(await waitForFile(pointerPath)).toBe(true);
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        url: string;
        mcpUrl: string;
      };

      const initReply = await httpGet(testCase.connectHost, port, '/__pyric/init.json', `localhost:${port}`);
      expect(initReply.status).toBe(200);
      const initBody = JSON.parse(initReply.body) as { bridgeUrl: string | null };
      expect(typeof initBody.bridgeUrl).toBe('string');

      await assertHostAcceptsAdvertisedUrl(pointer.url, `vite ${testCase.configuredHost} serve.json url`, testCase.connectHost, port);
      await assertHostAcceptsAdvertisedUrl(pointer.mcpUrl, `vite ${testCase.configuredHost} serve.json mcpUrl`, testCase.connectHost, port);
      await assertHostAcceptsAdvertisedUrl(String(initBody.bridgeUrl), `vite ${testCase.configuredHost} init.json bridgeUrl`, testCase.connectHost, port);

      // Security invariant: wildcard Host header is still refused with 403.
      const wildcardHealth = await httpGet(
        testCase.connectHost,
        port,
        '/__pyric/health',
        `${testCase.wildcardHeaderHost}:${port}`,
      );
      expect(wildcardHealth.status).toBe(403);
    }
  }, 30_000);
});
