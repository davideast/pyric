import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { injectServeAiEngineTag } from '../../src/serve/ai-engine-wire.js';
import { injectServeTags } from '../../src/serve/html-injection.js';
import { SANDBOX_BUILD_META } from '../../src/serve/sandbox-marker.js';
import type { ServeLogger } from '../../src/serve/server.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const { makeTempDir, cleanupTempDirs } = trackTempDirs('pyric-serve-ai-config-');
const sharedCacheRoot = makeTempDir('pyric-serve-ai-shared-cache-');
const cliEntry = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli/index.js');
const started: ServeRuntime[] = [];
const mockServers: Server[] = [];

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = probe();
    if (found !== null) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return probe();
}

function createProject(pyricJson: Record<string, unknown>): string {
  const dir = makeTempDir('pyric-serve-ai-proj-');
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  writeFileSync(
    join(dir, 'public/index.html'),
    '<!doctype html><html><head><title>ai</title></head><body>ok</body></html>',
  );
  writeFileSync(join(dir, 'pyric.json'), JSON.stringify(pyricJson));
  return dir;
}

function recordingLogger(): { logger: ServeLogger; infoLines: string[] } {
  const infoLines: string[] = [];
  return {
    logger: {
      info: (m) => infoLines.push(m),
      note: () => {},
    },
    infoLines,
  };
}

function listenMock(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  mockServers.push(server);
  return new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolveListen(`http://127.0.0.1:${address.port}`);
    }),
  );
}

function extractSessionCookie(setCookie: string | null): string | undefined {
  if (setCookie === null) return undefined;
  return setCookie.split(';', 1)[0];
}

afterEach(() => {
  for (const srv of mockServers.splice(0)) srv.close();
});

afterAll(async () => {
  while (started.length > 0) {
    const rt = started.pop();
    if (rt !== undefined) {
      await rt.handle.stop();
    }
  }
  cleanupTempDirs();
});

describe('pyric sandbox AI configuration surface (#373)', () => {
  it('injects globalThis.__PYRIC_AI_ENGINE__ ahead of the import map and escapes closing script sequences', () => {
    const base = injectServeTags('<!doctype html><html><head></head><body></body></html>');
    const injected = injectServeAiEngineTag(base, {
      kind: 'scripted',
      script: [{ respond: { text: '</script>' } }],
    });
    const engineIdx = injected.indexOf('data-pyric-ai-engine');
    const mapIdx = injected.indexOf('<script type="importmap"');
    expect(engineIdx).toBeGreaterThanOrEqual(0);
    expect(engineIdx).toBeLessThan(mapIdx);
    expect(injected).toContain('\\u003c/script>');
    expect(injectServeAiEngineTag(injected, { kind: 'gemini' })).toBe(injected);

    const buildHtml = `<!doctype html><html><head>${SANDBOX_BUILD_META}</head><body></body></html>`;
    expect(injectServeAiEngineTag(buildHtml, { kind: 'gemini' })).toBe(buildHtml);
    expect(injectServeAiEngineTag(base, undefined)).toBe(base);
  });

  it('wires pyric.json ai.model and ai.proxyUpstream into the banner, init.json, HTML, and /__pyric/ai-proxy', async () => {
    let upstreamPaths: string[] = [];
    const upstreamOrigin = await listenMock((req, res) => {
      upstreamPaths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'from-custom-upstream' }, finish_reason: 'stop' }],
        }),
      );
    });

    const cwd = createProject({
      ai: {
        model: 'llama3.2',
        proxyUpstream: `${upstreamOrigin}/v1`,
      },
    });
    const { logger, infoLines } = recordingLogger();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: sharedCacheRoot,
      logger,
    });
    started.push(runtime);

    const aiLine = infoLines.find((line) => line.includes(' ai '));
    expect(aiLine).toBeDefined();
    expect(aiLine).toContain('openai (model llama3.2)');
    expect(aiLine).toContain(`${upstreamOrigin}/v1 (ai.proxyUpstream)`);

    const pageRes = await fetch(`${runtime.handle.url}/`);
    expect(pageRes.status).toBe(200);
    const cookie = extractSessionCookie(pageRes.headers.get('set-cookie'));
    const html = await pageRes.text();
    expect(html).toContain(
      'globalThis.__PYRIC_AI_ENGINE__={"kind":"openai","baseUrl":"/__pyric/ai-proxy","model":"llama3.2"};',
    );

    const initRes = await fetch(`${runtime.handle.url}/__pyric/init.json`, {
      headers: cookie !== undefined ? { cookie } : {},
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as { ai?: unknown };
    expect(initJson.ai).toEqual({
      engine: {
        kind: 'openai',
        baseUrl: '/__pyric/ai-proxy',
        model: 'llama3.2',
      },
    });

    const proxyHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-pyric-session-token': runtime.sessionToken,
    };
    const proxyRes = await fetch(`${runtime.handle.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(proxyRes.status).toBe(200);
    expect(await proxyRes.text()).toContain('from-custom-upstream');
    expect(upstreamPaths).toEqual(['/v1/chat/completions']);
  }, 120_000);

  it('keeps Gemini apiKey server-side on /__pyric/ai-proxy/gemini while sanitizing browser wire values', async () => {
    const SECRET_KEY = 'AIzaSy-config-secret-373';
    const seenKeys: Array<string | null> = [];
    const geminiUpstream = await listenMock((req, res) => {
      seenKeys.push(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('key'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'gemini-proxied' }] }, finishReason: 'STOP' }],
        }),
      );
    });

    const cwd = createProject({
      ai: {
        engine: {
          kind: 'gemini',
          apiKey: SECRET_KEY,
          baseUrl: geminiUpstream,
        },
      },
    });
    const { logger, infoLines } = recordingLogger();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: sharedCacheRoot,
      logger,
    });
    started.push(runtime);

    const joinedBanner = infoLines.join('\n');
    expect(joinedBanner).toContain('gemini (API key set)');
    expect(joinedBanner).not.toContain(SECRET_KEY);

    const htmlRes = await fetch(`${runtime.handle.url}/`);
    const html = await htmlRes.text();
    expect(html).toContain('globalThis.__PYRIC_AI_ENGINE__={"kind":"gemini"};');
    expect(html).not.toContain(SECRET_KEY);
    expect(JSON.stringify(runtime.payload())).not.toContain(SECRET_KEY);
    expect(runtime.payload().ai).toEqual({ engine: { kind: 'gemini' } });

    const geminiRes = await fetch(
      `${runtime.handle.url}/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-session-token': runtime.sessionToken,
        },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
      },
    );
    expect(geminiRes.status).toBe(200);
    expect(await geminiRes.text()).toContain('gemini-proxied');
    expect(seenKeys).toEqual([SECRET_KEY]);
  }, 120_000);

  it('loads AI variables and VITE_GEMINI_API_KEY banner warnings from project .env files', async () => {
    const dotEnvModelDir = createProject({});
    writeFileSync(join(dotEnvModelDir, '.env'), 'PYRIC_AI_MODEL=qwen2.5:3b\n');
    const modelLogger = recordingLogger();
    const modelRuntime = await startServe({
      cwd: dotEnvModelDir,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: sharedCacheRoot,
      logger: modelLogger.logger,
    });
    started.push(modelRuntime);
    expect(modelLogger.infoLines.find((line) => line.includes(' ai '))).toContain('openai (model qwen2.5:3b)');
    expect(modelRuntime.payload().ai).toEqual({
      engine: { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: 'qwen2.5:3b' },
    });

    const dotEnvWarnDir = createProject({});
    const IGNORED_SECRET = 'AIzaSy-ignored-vite-env-373';
    writeFileSync(join(dotEnvWarnDir, '.env'), `VITE_GEMINI_API_KEY=${IGNORED_SECRET}\n`);
    const warnLogger = recordingLogger();
    const warnRuntime = await startServe({
      cwd: dotEnvWarnDir,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: sharedCacheRoot,
      logger: warnLogger.logger,
    });
    started.push(warnRuntime);
    const warnAiLine = warnLogger.infoLines.find((line) => line.includes(' ai ')) ?? '';
    expect(warnAiLine).toContain('VITE_GEMINI_API_KEY is set and ignored');
    expect(warnAiLine).not.toContain(IGNORED_SECRET);
  }, 120_000);

  it('wires full engineWire into startHostedSandbox under --hosted and rejects contradictory ai options', async () => {
    const badBoth = createProject({
      ai: { model: 'llama3.2', engine: { kind: 'scripted' } },
    });
    await expect(
      startServe({ cwd: badBoth, port: 0, host: '127.0.0.1', cacheRoot: sharedCacheRoot }),
    ).rejects.toThrow('pyric sandbox: Choose either ai.model or ai.engine, not both.');

    const badProd = createProject({
      ai: { mode: 'production', model: 'llama3.2' },
    });
    await expect(
      startServe({ cwd: badProd, port: 0, host: '127.0.0.1', cacheRoot: sharedCacheRoot }),
    ).rejects.toThrow(
      'pyric sandbox: Cannot configure ai.model or ai.engine when ai.mode is set to "production".',
    );

    const hostedCwd = createProject({
      ai: {
        engine: {
          kind: 'scripted',
          script: [{ respond: { text: 'hosted-scripted-373' } }],
        },
      },
    });

    let output = '';
    const child = spawn(
      'node',
      [cliEntry, 'sandbox', '--hosted', '--no-run', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      {
        cwd: hostedCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.stderr?.on('data', (chunk: string) => { output += chunk; });

    let ws: WebSocket | null = null;
    try {
      const pointer = await waitFor(() => {
        const pointerPath = join(hostedCwd, '.pyric/serve.json');
        if (!existsSync(pointerPath) || !output.includes('scripted (1 canned response(s), no network)')) {
          return null;
        }
        return JSON.parse(readFileSync(pointerPath, 'utf8')) as { url: string; token?: string };
      }, 30_000);
      expect(pointer).not.toBeNull();
      const baseUrl = (pointer?.url ?? '').replace(/\/$/, '');
      const wsHeaders: Record<string, string> = {};
      if (pointer?.token !== undefined) {
        wsHeaders['x-pyric-session-token'] = pointer.token;
      }
      const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/__pyric/sandbox`;
      ws = new WebSocket(wsUrl, { headers: wsHeaders });
      const activeWs = ws;
      const answer = await new Promise<{ ok: boolean; value?: unknown; error?: unknown }>((resolveOp, rejectOp) => {
        activeWs.once('error', rejectOp);
        activeWs.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as {
            type?: string;
            message?: { t?: string; id?: string; ok?: boolean; value?: unknown; error?: unknown };
          };
          if (frame.type === 'attach-ack') {
            activeWs.send(
              JSON.stringify({
                type: 'worker-message',
                message: {
                  t: 'op',
                  id: 'ai-op-1',
                  method: 'ai.generateContent',
                  model: 'gemini-2.5-flash',
                  request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
                },
              }),
            );
            return;
          }
          if (frame.type === 'worker-message-result' && frame.message?.t === 'res' && frame.message.id === 'ai-op-1') {
            resolveOp({
              ok: Boolean(frame.message.ok),
              value: frame.message.value,
              error: frame.message.error,
            });
          }
        });
        activeWs.once('open', () => {
          activeWs.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
        });
      });
      expect(answer.ok).toBe(true);
      expect(JSON.stringify(answer.value)).toContain('hosted-scripted-373');
    } finally {
      ws?.close();
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolveExit();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
  }, 120_000);
});
