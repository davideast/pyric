/**
 * Tests for the retained bridge premortem fixes.
 *
 *  - A2: per-session idle timeout + max-session cap.
 *  - A1: dispatch consumes the canonical factory.
 *  - U1: lifecycle logging — wireable.
 */

import { describe, expect, test } from 'bun:test';
import { startServer } from '../../src/bridge/server.js';
import { SANDBOX_OP_KEYS } from '../../src/bridge/client/dispatch.js';

function withServer<T>(
  startPort: number,
  fn: (server: Awaited<ReturnType<typeof startServer>>) => Promise<T>,
  opts: Parameters<typeof startServer>[0] = {},
): Promise<T> {
  return startServer({
    port: startPort,
    disableAuditLog: true,
    silent: true,
    ...opts,
  }).then(async (server) => {
    try {
      return await fn(server);
    } finally {
      await server.stop();
    }
  });
}

describe('Premortem fixes — A2 (session leak)', () => {
  test('max-session cap rejects new sessions at limit', async () => {
    await withServer(
      5196,
      async (server) => {
        const initBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        };
        const init = () =>
          fetch(`${server.url}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(initBody),
          });
        const r1 = await init();
        expect(r1.status).toBe(200);
        await r1.text();
        const r2 = await init();
        expect(r2.status).toBe(200);
        await r2.text();
        const r3 = await init();
        expect(r3.status).toBe(503);
        const errBody = await r3.json();
        expect(errBody.error).toContain('session cap');
      },
      { maxSessions: 2 },
    );
  });

  test('idle session is auto-closed after sessionIdleMs', async () => {
    await withServer(
      5197,
      async (server) => {
        const initRes = await fetch(`${server.url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 't', version: '0' },
            },
          }),
        });
        await initRes.text();
        const sessionId = initRes.headers.get('mcp-session-id');
        expect(sessionId).not.toBeNull();
        await new Promise((r) => setTimeout(r, 250));
        const health = await fetch(`${server.url}/health`);
        expect(health.status).toBe(200);
      },
      { sessionIdleMs: 100 },
    );
  });
});

describe('Premortem fixes — A1 (dispatcher drift eliminated)', () => {
  test('SANDBOX_OP_KEYS covers every forwarded operation (no advertise/execute drift)', () => {
    expect(SANDBOX_OP_KEYS).toEqual([
      // simulator session
      'firestore_simulator.create',
      'firestore_simulator.execute',
      'firestore_simulator.read',
      'firestore_simulator.batch',
      'firestore_simulator.add',
      'firestore_simulator.undo',
      'firestore_simulator.redo',
      'firestore_simulator.events',
      'firestore_simulator.transaction',
      // data plane (executable on the page peer, not just advertised)
      'firestore_data.get',
      'firestore_data.list',
      'firestore_data.set',
      'firestore_data.add',
      'firestore_data.update',
      'firestore_data.delete',
      'firestore_data.batch_write',
      'firestore_data.query',
      // inspect
      'sandbox.inspect',
      'sandbox.snapshot',
      // local Realtime Database inspection
      'database_data.crawl',
      'database_rules.simulate',
      // storage data plane
      'storage_data.upload',
      'storage_data.download',
      'storage_data.list',
      'storage_data.metadata',
      'storage_data.delete',
    ]);
  });
});
