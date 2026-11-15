import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type ServerHandle } from '../../src/bridge/server/standalone.js';
import { createBridgeMount, type BridgeMount } from '../../src/serve/bridge-mount.js';

interface RawHttpResult {
  timedOut: boolean;
  statusLine: string | null;
  statusCode: number | null;
  body: string;
}

function sendRawHttp(port: number, rawRequest: string, timeoutMs = 1_500): Promise<RawHttpResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let data = '';
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const headerEnd = data.indexOf('\r\n\r\n');
      let statusLine: string | null = null;
      if (data.length > 0) {
        statusLine = data.split('\r\n')[0] ?? null;
      }
      const codeMatch = statusLine?.match(/^HTTP\/\d\.\d\s+(\d{3})\b/);
      let statusCode: number | null = null;
      if (codeMatch) {
        statusCode = Number(codeMatch[1]);
      }
      let body = '';
      if (headerEnd >= 0) {
        body = data.slice(headerEnd + 4);
      }
      resolve({ timedOut, statusLine, statusCode, body });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.on('connect', () => {
      socket.write(rawRequest);
    });
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

function parseSseOrJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) {
      return JSON.parse(line.slice(5).trim());
    }
  }
  throw new Error(`Unparseable MCP response: ${text}`);
}

async function callHttpMcp(
  url: string,
  body: Record<string, unknown>,
  sessionId: string | null = null,
  extraHeaders: Record<string, string> = {},
): Promise<{ sessionId: string | null; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (sessionId !== null) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP MCP ${response.status}: ${text}`);
  }
  let json: Record<string, unknown> | null = null;
  if (text.trim().length > 0) {
    json = parseSseOrJson(text) as Record<string, unknown>;
  }
  return {
    sessionId: response.headers.get('mcp-session-id') ?? sessionId,
    json,
  };
}

function createProjectFixture(prefix: string): { root: string; projectDir: string; otherCwd: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectDir = join(root, 'app-project');
  const otherCwd = join(root, 'other-cwd');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(otherCwd, { recursive: true });
  writeFileSync(
    join(projectDir, 'firebase.json'),
    JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
  );
  writeFileSync(
    join(projectDir, 'firestore.rules'),
    "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /items/{id} { allow read, write: if true; } } }",
  );
  return { root, projectDir, otherCwd };
}

const standaloneServers: ServerHandle[] = [];
const httpServers: Server[] = [];
const mounts: BridgeMount[] = [];
const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  while (standaloneServers.length > 0) {
    await standaloneServers.pop()?.stop();
  }
  while (mounts.length > 0) {
    await mounts.pop()?.close();
  }
  while (httpServers.length > 0) {
    const server = httpServers.pop();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('standalone bridge host validation and mounted HTTP MCP projectDir', () => {
  it('rejects malformed or empty Host headers and malformed request URLs cleanly without unhandled rejections', async () => {
    const rejections: string[] = [];
    const onRejection = (err: unknown): void => {
      if (err instanceof Error) {
        rejections.push(`${err.name}: ${err.message}`);
      } else {
        rejections.push(String(err));
      }
    };
    process.on('unhandledRejection', onRejection);
    try {
      const server = await startServer({ port: 0, disableAuditLog: true, silent: true });
      standaloneServers.push(server);

      const healthy = await sendRawHttp(
        server.port,
        `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(healthy.timedOut).toBe(false);
      expect(healthy.statusCode).toBe(200);

      const badHosts = ['[::1', 'bad host', '127.0.0.1:99999', ''];
      for (const badHost of badHosts) {
        const result = await sendRawHttp(
          server.port,
          `GET /health HTTP/1.1\r\nHost: ${badHost}\r\nConnection: close\r\n\r\n`,
        );
        expect(result.timedOut, `host=${JSON.stringify(badHost)}`).toBe(false);
        expect([400, 403], `host=${JSON.stringify(badHost)}`).toContain(result.statusCode ?? 0);
      }

      const badUrl = await sendRawHttp(
        server.port,
        `GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(badUrl.timedOut).toBe(false);
      expect(badUrl.statusCode).toBe(400);

      // Server remains healthy after adversarial requests.
      const after = await sendRawHttp(
        server.port,
        `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(after.timedOut).toBe(false);
      expect(after.statusCode).toBe(200);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('stamps configured projectDir on standalone HTTP MCP initialize and tool envelopes regardless of process.cwd()', async () => {
    const { root, projectDir, otherCwd } = createProjectFixture('pyric-standalone-projdir-');
    tempDirs.push(root);
    const realProjectDir = realpathSync(projectDir);

    process.chdir(otherCwd);
    const server = await startServer({
      port: 0,
      projectDir,
      disableAuditLog: true,
      silent: true,
    });
    standaloneServers.push(server);

    const init = await callHttpMcp(server.mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });
    const initResult = init.json?.result as { instructions?: string } | undefined;
    expect(initResult?.instructions).toContain(realProjectDir);
    expect(initResult?.instructions).not.toMatch(/no Firebase or Pyric project markers/i);

    await callHttpMcp(
      server.mcpUrl,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      init.sessionId,
    );

    const call = await callHttpMcp(
      server.mcpUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'auth_whoami', arguments: {} } },
      init.sessionId,
    );
    const callResult = call.json?.result as { content?: Array<{ text: string }> } | undefined;
    const payload = JSON.parse(callResult?.content?.[0]?.text ?? '{}') as {
      _pyric?: { projectDir?: string; isProject?: boolean };
    };
    expect(payload._pyric?.projectDir).toBe(realProjectDir);
    expect(payload._pyric?.isProject).toBe(true);
  });

  it('stamps configured projectDir on mounted HTTP /__pyric/mcp initialize and tool envelopes regardless of process.cwd()', async () => {
    const { root, projectDir, otherCwd } = createProjectFixture('pyric-mounted-projdir-');
    tempDirs.push(root);
    const realProjectDir = realpathSync(projectDir);

    process.chdir(otherCwd);
    const mount = createBridgeMount({
      projectKey: projectDir,
      disableAuditLog: true,
    });
    mounts.push(mount);

    const httpServer = createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      void mount.handler(req, res, parsed).then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404).end();
        }
      });
    });
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('Expected TCP address for mounted test server');
    }
    const attachment = mount.attachHost({
      servers: [httpServer],
      projectDir,
      origin: () => ({ host: '127.0.0.1', port: address.port }),
      closeOnServerClose: false,
    });

    try {
      const mcpUrl = `http://127.0.0.1:${address.port}/__pyric/mcp`;
      const init = await callHttpMcp(mcpUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });
      const initResult = init.json?.result as { instructions?: string } | undefined;
      expect(initResult?.instructions).toContain(realProjectDir);
      expect(initResult?.instructions).not.toMatch(/no Firebase or Pyric project markers/i);

      await callHttpMcp(
        mcpUrl,
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        init.sessionId,
      );

      const call = await callHttpMcp(
        mcpUrl,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'auth_whoami', arguments: {} } },
        init.sessionId,
      );
      const callResult = call.json?.result as { content?: Array<{ text: string }> } | undefined;
      const payload = JSON.parse(callResult?.content?.[0]?.text ?? '{}') as {
        _pyric?: { projectDir?: string; isProject?: boolean };
      };
      expect(payload._pyric?.projectDir).toBe(realProjectDir);
      expect(payload._pyric?.isProject).toBe(true);
    } finally {
      await attachment.close();
    }
  });
});
