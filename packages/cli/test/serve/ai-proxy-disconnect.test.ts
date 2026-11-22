import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { fetchAiUpstream, handleAiProxy } from '../../src/serve/ai-proxy.js';
import { watchAiProxyClientDisconnect } from '../../src/serve/ai-proxy-disconnect.js';
import { createGeminiProxy, GEMINI_PROXY_PATH } from '../../src/serve/gemini-proxy.js';
import { resolveNodeExecutable } from './require-node-on-path.js';

interface MockHttpPair {
  req: IncomingMessage & EventEmitter;
  res: ServerResponse & EventEmitter;
  headersWritten: () => boolean;
}

function createMockPostPair(bodyText: string): MockHttpPair {
  const reqEmitter = new EventEmitter();
  let wroteHead = false;
  let ended = false;
  let destroyed = false;
  const bodyBytes = Buffer.from(bodyText, 'utf8');
  let consumed = false;

  const req = Object.assign(reqEmitter, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    aborted: false,
    complete: false,
    destroy() {
      destroyed = true;
      return req;
    },
    async *[Symbol.asyncIterator]() {
      if (!consumed) {
        consumed = true;
        yield bodyBytes;
      }
      req.complete = true;
      // Node 24 IncomingMessage autoDestroy emits 'close' on req immediately after body EOF.
      reqEmitter.emit('close');
    },
  }) as unknown as IncomingMessage & EventEmitter;

  // Also wire 'data' + 'end' for stream-listener body readers such as collectRawBody.
  reqEmitter.on('newListener', (event: string) => {
    if (event === 'data' && !consumed) {
      consumed = true;
      queueMicrotask(() => {
        reqEmitter.emit('data', bodyBytes);
        (req as { complete: boolean }).complete = true;
        reqEmitter.emit('end');
        reqEmitter.emit('close');
      });
    }
  });

  const resEmitter = new EventEmitter();
  const res = Object.assign(resEmitter, {
    get writableEnded() {
      return ended;
    },
    get destroyed() {
      return destroyed;
    },
    writeHead() {
      wroteHead = true;
      return res;
    },
    write() {
      return true;
    },
    end() {
      ended = true;
      resEmitter.emit('close');
      return res;
    },
  }) as unknown as ServerResponse & EventEmitter;

  return {
    req,
    res,
    headersWritten: () => wroteHead,
  };
}

describe('AI proxy client disconnect before upstream headers (#1634)', () => {
  it('does not abort when Node IncomingMessage emits close on normal POST body EOF', () => {
    const { req, res } = createMockPostPair('{"contents":[]}');
    const disconnect = watchAiProxyClientDisconnect(req, res);
    req.emit('close');
    expect(disconnect.isDisconnected()).toBe(false);
    expect(disconnect.signal.aborted).toBe(false);
    res.emit('close');
    expect(disconnect.isDisconnected()).toBe(true);
    expect(disconnect.signal.aborted).toBe(true);
    disconnect.dispose();
  });

  it('cancels upstream fetch quietly on /__pyric/ai-proxy when client drops before headers arrive', async () => {
    const realFetch = globalThis.fetch;
    let seenSignal: AbortSignal | undefined;
    const notes: string[] = [];
    const logger = { info: () => {}, note: (msg: string) => notes.push(msg) };

    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          seenSignal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            },
            { once: true },
          );
        }),
      { preconnect: realFetch.preconnect },
    );

    try {
      const pair = createMockPostPair('{"stream":true}');
      const pending = handleAiProxy(
        'http://127.0.0.1:11434/v1',
        { shouldPrint: () => true },
        pair.req,
        pair.res,
        new URL('http://127.0.0.1/__pyric/ai-proxy/chat/completions'),
        logger,
      );

      // Wait until upstream fetch received its signal, then simulate client disconnect before headers.
      while (seenSignal === undefined) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seenSignal.aborted).toBe(false);
      pair.res.emit('close');
      await pending;

      expect(seenSignal.aborted).toBe(true);
      expect(pair.headersWritten()).toBe(false);
      expect(notes).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('cancels GeminiUpstream fetch quietly on /__pyric/ai-proxy/gemini when client drops before headers arrive', async () => {
    const realFetch = globalThis.fetch;
    let seenSignal: AbortSignal | undefined;
    const notes: string[] = [];
    const logger = { info: () => {}, note: (msg: string) => notes.push(msg) };

    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          seenSignal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            },
            { once: true },
          );
        }),
      { preconnect: realFetch.preconnect },
    );

    try {
      const handler = createGeminiProxy(
        { baseUrl: 'http://127.0.0.1:19999', apiKey: 'server-gemini-secret-1634' },
        { shouldPrint: () => true },
        logger,
      );
      const pair = createMockPostPair('{"contents":[]}');
      const pending = handler(
        pair.req,
        pair.res,
        new URL(`http://127.0.0.1${GEMINI_PROXY_PATH}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`),
      );

      while (seenSignal === undefined) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seenSignal.aborted).toBe(false);
      pair.res.emit('close');
      await pending;

      expect(seenSignal.aborted).toBe(true);
      expect(pair.headersWritten()).toBe(false);
      expect(notes).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('suppresses unreachable diagnostic in fetchAiUpstream when caller AbortSignal aborts', async () => {
    const realFetch = globalThis.fetch;
    const notes: string[] = [];
    const logger = { info: () => {}, note: (msg: string) => notes.push(msg) };
    const ac = new AbortController();

    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
      { preconnect: realFetch.preconnect },
    );

    try {
      const promise = fetchAiUpstream(
        'http://127.0.0.1:19999/v1/chat/completions',
        { method: 'POST', signal: ac.signal },
        { shouldPrint: () => true },
        logger,
      );
      ac.abort();
      await expect(promise).rejects.toThrow();
      expect(notes).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('stops a delayed Node upstream before headers on both /__pyric/ai-proxy and /__pyric/ai-proxy/gemini', () => {
    const cliDistDir = fileURLToPath(new URL('../../dist/serve/', import.meta.url));
    const serverModUrl = pathToFileURL(`${cliDistDir}server.js`).href;
    const namespaceModUrl = pathToFileURL(`${cliDistDir}namespace.js`).href;

    const childScript = [
      "import { createServer } from 'node:http';",
      "import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      `const { silentServeLogger, startStaticServer } = await import(${JSON.stringify(serverModUrl)});`,
      `const { createPyricNamespace } = await import(${JSON.stringify(namespaceModUrl)});`,
      '',
      'const records = [];',
      'const upstream = createServer((req, res) => {',
      '  const started = Date.now();',
      '  const rec = { url: req.url, leftAtMs: null, chunksWritten: 0 };',
      '  records.push(rec);',
      '  req.resume();',
      '  res.on("close", () => {',
      '    if (!res.writableEnded && rec.leftAtMs === null) rec.leftAtMs = Date.now() - started;',
      '  });',
      '  const headerTimer = setTimeout(() => {',
      '    if (res.destroyed || res.writableEnded) return;',
      '    res.writeHead(200, { "content-type": "text/event-stream" });',
      '    let i = 0;',
      '    const iv = setInterval(() => {',
      '      if (res.destroyed || i >= 20) { clearInterval(iv); if (!res.destroyed) res.end(); return; }',
      '      i += 1; rec.chunksWritten += 1;',
      '      res.write(`data: {"n":${i}}\\n\\n`);',
      '    }, 20);',
      '  }, 600);',
      '  headerTimer.unref();',
      '});',
      'await new Promise((r) => upstream.listen(0, "127.0.0.1", r));',
      'const upUrl = `http://127.0.0.1:${upstream.address().port}`;',
      '',
      'const dir = mkdtempSync(join(tmpdir(), "pyric-1634-node-"));',
      'const site = join(dir, "public"); const sdk = join(dir, "sdk");',
      'mkdirSync(site); mkdirSync(sdk);',
      'writeFileSync(join(site, "index.html"), "<!doctype html>");',
      'const notes = [];',
      'const logger = { ...silentServeLogger(), note: (m) => notes.push(m) };',
      'const token = "tok-1634";',
      'const ns = createPyricNamespace({',
      '  sdkDir: sdk,',
      '  initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),',
      '  aiProxyUpstream: `${upUrl}/v1`,',
      '  aiGemini: { baseUrl: upUrl, apiKey: "server-secret-1634" },',
      '  sessionToken: token,',
      '  logger,',
      '});',
      'const handle = await startStaticServer({',
      '  publicDir: site, port: 0, host: "127.0.0.1", portScanLimit: 50, logger, namespaceHandler: ns, sessionToken: token,',
      '});',
      '',
      'async function postAndDropEarly(path) {',
      '  const ac = new AbortController();',
      '  setTimeout(() => ac.abort(), 120);',
      '  try {',
      '    await fetch(`${handle.url}${path}`, {',
      '      method: "POST",',
      '      headers: { "content-type": "application/json", "x-pyric-session-token": token },',
      '      body: "{\\"contents\\":[]}",',
      '      signal: ac.signal,',
      '    });',
      '  } catch {}',
      '  await new Promise((r) => setTimeout(r, 200));',
      '}',
      '',
      'await postAndDropEarly("/__pyric/ai-proxy/chat/completions");',
      'await postAndDropEarly("/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");',
      'await handle.stop();',
      'upstream.close();',
      'rmSync(dir, { recursive: true, force: true });',
      'console.log(JSON.stringify({ records, notes }));',
      'process.exit(0);',
    ].join('\n');

    const nodeBin = resolveNodeExecutable();
    const result = spawnSync(nodeBin, ['--input-type=module', '-e', childScript], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      records: Array<{ url: string; leftAtMs: number | null; chunksWritten: number }>;
      notes: string[];
    };
    expect(parsed.notes).toEqual([]);
    expect(parsed.records).toHaveLength(2);
    for (const rec of parsed.records) {
      expect(rec.chunksWritten).toBe(0);
      expect(rec.leftAtMs).not.toBeNull();
      expect((rec.leftAtMs ?? 9999) < 500).toBe(true);
    }
  }, 30_000);
});
