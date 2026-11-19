import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { Agent, request as httpRequest } from 'node:http';
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  configureLocalHttpKeepAlive,
} from '../../src/serve/http-keepalive.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

const handles: ServeHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) {
      await handle.stop();
    }
  }
});

function resolveNodeBinary(): string {
  if (process.execPath.endsWith('node')) {
    return process.execPath;
  }
  return 'node';
}

function pooledGet(agent: Agent, port: number, path: string): Promise<{
  status: number;
  body: string;
  localPort: number;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        agent,
        headers: { Connection: 'keep-alive' },
      },
      (res) => {
        const localPort = res.socket?.localPort ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            localPort,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('local HTTP keep-alive configuration (#1279, #1589)', () => {
  it('configures keepAliveTimeout >= 65s and headersTimeout > keepAliveTimeout on every bound static server', async () => {
    expect(HTTP_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(65_000);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeGreaterThan(HTTP_KEEP_ALIVE_TIMEOUT_MS);

    const handle = await startStaticServer({
      publicDir: null,
      port: 0,
      host: 'localhost',
      logger: silentServeLogger(),
      namespaceHandler: (_req, res, url) => {
        if (url.pathname === '/__pyric/sdk/worker.js') {
          res.writeHead(200, { 'content-type': 'application/javascript' });
          res.end('/* worker */');
          return true;
        }
        return false;
      },
    });
    handles.push(handle);

    expect(handle.servers.length).toBeGreaterThanOrEqual(1);
    for (const server of handle.servers) {
      expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
      expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
    }

    const agent = new Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 });
    try {
      const first = await pooledGet(agent, handle.port, '/__pyric/sdk/worker.js');
      expect(first.status).toBe(200);
      expect(first.localPort).toBeGreaterThan(0);

      const second = await pooledGet(agent, handle.port, '/__pyric/sdk/worker.js');
      expect(second.status).toBe(200);
      expect(second.localPort).toBe(first.localPort);
    } finally {
      agent.destroy();
    }
  });

  it(
    'keeps an idle Node startStaticServer keep-alive socket reusable past Node default 5s timeout',
    () => {
      // Runs inside real Node (`pyric sandbox` host runtime) to verify that
      // `startStaticServer` keeps a pooled reverse-proxy socket open across the
      // ~5s initial Next.js compile window that previously failed `/__pyric/sdk/worker.js` with ECONNRESET.
      const serverModuleHref = new URL('../../dist/serve/server.js', import.meta.url).href;
      const script = [
        "import { Agent, request } from 'node:http';",
        `import { silentServeLogger, startStaticServer } from ${JSON.stringify(serverModuleHref)};`,
        'const handle = await startStaticServer({',
        '  publicDir: null,',
        '  port: 0,',
        "  host: '127.0.0.1',",
        '  logger: silentServeLogger(),',
        '  namespaceHandler: (_req, res, url) => {',
        "    if (url.pathname === '/__pyric/sdk/worker.js') {",
        "      res.writeHead(200, { 'content-type': 'application/javascript' });",
        "      res.end('ok');",
        '      return true;',
        '    }',
        '    return false;',
        '  },',
        '});',
        'const agent = new Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 });',
        'const getOnce = () => new Promise((resolve, reject) => {',
        "  const req = request({ hostname: '127.0.0.1', port: handle.port, path: '/__pyric/sdk/worker.js', agent }, (res) => {",
        '    const localPort = res.socket.localPort;',
        "    res.resume(); res.on('end', () => resolve({ status: res.statusCode, localPort }));",
        '  });',
        "  req.on('error', reject); req.end();",
        '});',
        'const first = await getOnce();',
        'await new Promise((resolve) => setTimeout(resolve, 5_200));',
        'const second = await getOnce();',
        'agent.destroy();',
        'await handle.stop();',
        'console.log(JSON.stringify({ keepAliveTimeout: handle.server.keepAliveTimeout, headersTimeout: handle.server.headersTimeout, sameSocket: first.localPort === second.localPort, status: second.status }));',
      ].join('\n');

      const nodeBin = resolveNodeBinary();
      const stdout = execFileSync(nodeBin, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      const trimmed = stdout.trim();
      const result = JSON.parse(trimmed) as {
        keepAliveTimeout: number;
        headersTimeout: number;
        sameSocket: boolean;
        status: number;
      };
      expect(result).toEqual({
        keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
        headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
        sameSocket: true,
        status: 200,
      });
    },
    15_000,
  );

  it('applies configureLocalHttpKeepAlive idempotently and returns the server', () => {
    const fakeServer = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };
    const configured = configureLocalHttpKeepAlive(fakeServer);
    expect(configured).toBe(fakeServer);
    expect(fakeServer.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(fakeServer.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
  });
});
