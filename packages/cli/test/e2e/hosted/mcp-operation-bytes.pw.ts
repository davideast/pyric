import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpByteWriteArgs } from './mcp-byte-fixture.js';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

for (const completion of ['success', 'failure', 'timeout']) {
  test(`MCP byte capacity is restored after ${completion} and belongs to each session`, async ({ page }) => {
    test.setTimeout(60_000);
    const project = `mcp-byte-${randomUUID()}`;
    const auditDirectory = join(homedir(), '.pyric', 'projects', project);
    const fixture = await startSoakServe({
      flags: ['--no-capture', '--project', project],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const held: Array<() => void> = [];
    const forwardedBytes: number[] = [];
    let excessFrames = 0;
    let failsReplies = completion === 'failure';
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => server.send(raw));
      server.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
        if (isToolCall) {
          const holdsWrite = frame.name === 'firestore_create_document' && typeof frame.args.path === 'string' && frame.args.path.startsWith('held/');
          if (holdsWrite) {
            forwardedBytes.push(Buffer.byteLength(raw.toString()));
            held.push(() => {
              if (failsReplies) {
                server.send(JSON.stringify({ type: 'tool-result', id: frame.id, ok: false, error: { message: 'Controlled refusal' } }));
                return;
              }
              route.send(raw);
            });
            return;
          }
          const isExcessWrite = frame.name === 'firestore_create_document' && frame.args.path === 'limit/refused';
          if (isExcessWrite) excessFrames += 1;
        }
        route.send(raw);
      });
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      const busy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      const healthy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await busy.initialize();
      await healthy.initialize();
      const identity = await healthy.toolCall('auth_whoami', {});
      for (const round of ['first', 'second']) {
        forwardedBytes.length = 0;
        const accepted = Array.from({ length: 32 }, (_, index) =>
          busy.toolCall('firestore_create_document', mcpByteWriteArgs(`held/${round}-${index}`, index))
            .catch(error => ({ ok: false, summary: String(error) })));
        await expect.poll(() => held.length, round).toBe(32);
        const queuedWireBytes = forwardedBytes.reduce((total, bytes) => total + bytes, 0);
        expect(queuedWireBytes).toBeGreaterThan(24 * 1024 * 1024 - 4096);
        expect(queuedWireBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
        await expect(busy.toolCall('firestore_create_document', {
          path: 'limit/refused', data: { message: 'é'.repeat(4096) }, as: 'admin',
        })).resolves.toMatchObject({ ok: false, summary: 'resource-exhausted: This client exceeds the 24 MiB queued operation byte limit.' });
        expect(excessFrames).toBe(0);
        await expect(busy.toolCall('auth_impersonate', { uid: 'refused', claims: { padding: 'é'.repeat(4096) } })).resolves.toMatchObject({
          ok: false, summary: 'resource-exhausted: This client exceeds the 24 MiB queued operation byte limit.',
        });
        await expect(healthy.toolCall('auth_whoami', {})).resolves.toEqual(identity);
        await expect(healthy.toolCall('firestore_get_document', { path: 'limit/refused', as: 'admin' }))
          .resolves.toMatchObject({ ok: true, data: { exists: false } });
        const timesOut = completion === 'timeout' && round === 'first';
        const receivesReplies = !timesOut;
        if (receivesReplies) {
          held.shift()?.();
          const firstSucceeds = !failsReplies;
          await expect(accepted[0]).resolves.toMatchObject({ ok: firstSucceeds });
          accepted.push(busy.toolCall('firestore_create_document', mcpByteWriteArgs(`held/${round}-replacement`, 0))
            .catch(error => ({ ok: false, summary: String(error) })));
          await expect.poll(() => held.length).toBe(32);
          for (const release of held.splice(0)) release();
        }
        const results = await Promise.all(accepted);
        const expectsSuccess = !failsReplies && !timesOut;
        for (const result of results) expect(result.ok).toBe(expectsSuccess);
        if (timesOut) {
          for (const result of results) expect(result.summary).toContain('timed out after 30000ms');
          held.splice(0);
        }
        failsReplies = false;
      }
    } finally {
      await page.close().finally(() => fixture.stop()).finally(() => {
        rmSync(auditDirectory, { recursive: true, force: true });
      });
    }
  });
}
