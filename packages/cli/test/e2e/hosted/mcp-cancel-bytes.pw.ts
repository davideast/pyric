import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpByteWriteArgs } from './mcp-byte-fixture.js';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const cancellation of ['requests', 'session']) {
  test(`canceling MCP ${cancellation} restores its queued byte allowance`, async ({ page }) => {
    const project = `mcp-byte-cancellation-${randomUUID()}`;
    const auditDirectory = join(homedir(), '.pyric', 'projects', project);
    const auditPath = join(auditDirectory, 'events.ndjson');
    const fixture = await startSoakServe({
      flags: ['--no-capture', '--project', project],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    let client = new Client({ name: 'byte-cancellation', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${fixture.info.url}/__pyric/mcp`));
    const held: Array<() => void> = [];
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => server.send(raw));
      server.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
        if (isToolCall) {
          const holdsWrite = frame.name === 'firestore_create_document' && typeof frame.args.path === 'string' && frame.args.path.startsWith('held/');
          if (holdsWrite) {
            held.push(() => route.send(raw));
            return;
          }
        }
        route.send(raw);
      });
    });
    function countCanceledToolEvents(): number {
      const isAuditMissing = !existsSync(auditPath);
      if (isAuditMissing) return 0;
      const lines = readFileSync(auditPath, 'utf8').split('\n').slice(0, -1);
      return lines.filter(line => {
        const event: unknown = JSON.parse(line);
        const hasResult = event !== null && typeof event === 'object' && 'result' in event;
        if (hasResult) {
          const result = event.result;
          const hasSummary = result !== null && typeof result === 'object' && 'summary' in result;
          if (hasSummary) return result.summary === 'Tool call canceled; any dispatched mutation may already have committed.';
        }
        return false;
      }).length;
    }
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      await client.connect(transport);
      const controllers = Array.from({ length: 32 }, () => new AbortController());
      const calls = controllers.map((controller, index) => client.callTool({
        name: 'firestore_create_document', arguments: mcpByteWriteArgs(`held/first-${index}`, index),
      }, undefined, { signal: controller.signal }).then(() => 'completed', () => 'canceled'));
      await expect.poll(() => held.length).toBe(32);
      const closesSession = cancellation === 'session';
      if (closesSession) {
        await transport.terminateSession();
        await client.close();
      } else {
        for (const controller of controllers) controller.abort();
      }
      // Audit events are public completion records, not private pending-map inspection.
      await expect.poll(countCanceledToolEvents).toBe(32);
      expect(await Promise.all(calls)).toEqual(Array(32).fill('canceled'));
      held.splice(0);
      if (closesSession) {
        client = new Client({ name: 'replacement-session', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${fixture.info.url}/__pyric/mcp`)));
      }
      await expect.poll(() => client.callTool({ name: 'auth_whoami', arguments: {} })).toMatchObject({ isError: false });
      const next = Array.from({ length: 32 }, (_, index) => client.callTool({
        name: 'firestore_create_document', arguments: mcpByteWriteArgs(`held/second-${index}`, index),
      }).catch(error => ({ isError: true, error: String(error) })));
      await expect.poll(() => held.length).toBe(32);
      await expect(client.callTool({ name: 'auth_impersonate', arguments: { uid: 'refused', claims: { padding: 'é'.repeat(4096) } } })).resolves.toMatchObject({
        isError: true, content: [{ type: 'text', text: expect.stringContaining('resource-exhausted') }],
      });
      for (const release of held.splice(0)) release();
      for (const result of await Promise.all(next)) expect(result.isError).toBe(false);
      await test.info().attach('canceled-tool-events', {
        body: JSON.stringify({ canceledToolEvents: countCanceledToolEvents() }), contentType: 'application/json',
      });
    } finally {
      await client.close().finally(() => page.close()).finally(() => fixture.stop()).finally(() => {
        rmSync(auditDirectory, { recursive: true, force: true });
      });
    }
  });
}
