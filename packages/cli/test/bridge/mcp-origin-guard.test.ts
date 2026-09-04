import { describe, expect, it } from 'bun:test';
import { startServer as startBridgeServer } from '../../src/bridge/server/standalone.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { startStaticServer, silentServeLogger } from '../../src/serve/server.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MCP Bridge HTTP Origin and Host Verification Guard', () => {
  describe('Standalone Bridge (/mcp)', () => {
    it('rejects cross-origin HTTP POST /mcp with 403 Forbidden', async () => {
      const server = await startBridgeServer({
        port: 0,
        silent: true,
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Origin': 'https://malicious-attacker.com',
            'Host': '127.0.0.1',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'attacker-client', version: '1.0' },
            },
          }),
        });

        expect(res.status).toBe(403);
        const data = (await res.json()) as { error?: string };
        expect(data.error).toContain('Forbidden: invalid host or origin');
      } finally {
        await server.stop();
      }
    });

    it('rejects cross-origin HTTP GET and DELETE /mcp with 403 Forbidden', async () => {
      const server = await startBridgeServer({
        port: 0,
        silent: true,
      });

      try {
        const getRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'GET',
          headers: {
            'Origin': 'https://evil.org',
            'Host': '127.0.0.1',
          },
        });
        expect(getRes.status).toBe(403);

        const delRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'DELETE',
          headers: {
            'Origin': 'https://evil.org',
            'Host': '127.0.0.1',
          },
        });
        expect(delRes.status).toBe(403);
      } finally {
        await server.stop();
      }
    });

    it('rejects HTTP POST /mcp with unapproved Host header with 403 Forbidden', async () => {
      const server = await startBridgeServer({
        port: 0,
        silent: true,
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Host': 'attacker-controlled-host.com',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        });

        expect(res.status).toBe(403);
      } finally {
        await server.stop();
      }
    });

    it('allows loopback HTTP POST /mcp without Origin or with loopback Origin', async () => {
      const server = await startBridgeServer({
        port: 0,
        silent: true,
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Host': `127.0.0.1:${server.port}`,
            'Origin': `http://127.0.0.1:${server.port}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'valid-client', version: '1.0' },
            },
          }),
        });

        expect(res.status).toBe(200);
      } finally {
        await server.stop();
      }
    });
  });

  describe('Mounted Bridge (/__pyric/mcp)', () => {
    it('rejects cross-origin HTTP POST /__pyric/mcp with 403 Forbidden', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mount-origin-test-'));
      mkdirSync(join(tempDir, 'public'));
      writeFileSync(join(tempDir, 'public', 'index.html'), '<html></html>');

      const mount = createBridgeMount({
        project: 'test-proj',
        disableAuditLog: true,
        upgradeGuard: { boundHost: '127.0.0.1' },
      });

      const serverHandle = await startStaticServer({
        publicDir: join(tempDir, 'public'),
        port: 0,
        host: '127.0.0.1',
        logger: silentServeLogger(),
        namespaceHandler: mount.handler,
      });

      try {
        const res = await fetch(`${serverHandle.url}/__pyric/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Origin': 'https://evil-site.com',
            'Host': '127.0.0.1',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'attacker', version: '1.0' },
            },
          }),
        });

        expect(res.status).toBe(403);
      } finally {
        await serverHandle.stop();
        await mount.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('allows loopback HTTP POST /__pyric/mcp with same-origin or no Origin', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mount-origin-test-'));
      mkdirSync(join(tempDir, 'public'));
      writeFileSync(join(tempDir, 'public', 'index.html'), '<html></html>');

      const mount = createBridgeMount({
        project: 'test-proj',
        disableAuditLog: true,
        upgradeGuard: { boundHost: '127.0.0.1' },
      });

      const serverHandle = await startStaticServer({
        publicDir: join(tempDir, 'public'),
        port: 0,
        host: '127.0.0.1',
        logger: silentServeLogger(),
        namespaceHandler: mount.handler,
      });

      try {
        const res = await fetch(`${serverHandle.url}/__pyric/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Origin': serverHandle.url,
            'Host': `127.0.0.1:${serverHandle.port}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'legit-client', version: '1.0' },
            },
          }),
        });

        expect(res.status).toBe(200);
      } finally {
        await serverHandle.stop();
        await mount.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
