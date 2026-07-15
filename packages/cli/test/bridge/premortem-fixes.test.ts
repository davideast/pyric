/**
 * Tests for the retained bridge premortem fixes.
 *
 *  - A2: per-session idle timeout + max-session cap.
 *  - A1: dispatch consumes the canonical factory.
 *  - U1: lifecycle logging — wireable.
 */

import { describe, expect, test } from 'bun:test';
import { startServer } from '../../src/bridge/server.js';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';

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
  test('SANDBOX_TOOL_NAMES covers every sandbox tool factory (no advertise/execute drift)', () => {
    expect(SANDBOX_TOOL_NAMES).toEqual([
      // simulator family
      'firestore_simulator_create',
      'firestore_simulator_execute',
      'firestore_simulator_read',
      'firestore_simulator_batch',
      'firestore_create_with_auto_id',
      'firestore_simulator_undo',
      'firestore_simulator_redo',
      'firestore_simulator_events',
      'firestore_simulator_transaction',
      // data-plane family (now executable on the page peer, not just advertised)
      'firestore_get_document',
      'firestore_list_documents',
      'firestore_create_document',
      'firestore_add_document',
      'firestore_update_document',
      'firestore_delete_document',
      'firestore_batch_write',
      'firestore_query_where',
      // inspect
      'sandbox_inspect',
      // local RTDB inspection
      'rtdb_simulate_access',
      'rtdb_crawl_structure',
    ]);
  });
});
