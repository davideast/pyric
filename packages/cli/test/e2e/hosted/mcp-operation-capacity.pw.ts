import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

for (const completion of ['success', 'failure', 'timeout']) {
  test(`MCP capacity is restored after ${completion} and belongs to each session`, async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const held: Array<() => void> = [];
    let excessFrames = 0;
    let failsReplies = completion === 'failure';
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => server.send(raw));
      server.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
        if (isToolCall) {
          const holdsRead = frame.name === 'firestore_get_document' && frame.args.path === 'shared/held';
          if (holdsRead) {
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
      for (const round of ['first', 'second']) {
        const accepted = Array.from({ length: 256 }, () =>
          busy.toolCall('firestore_get_document', { path: 'shared/held', as: 'admin' })
            .catch(error => ({ ok: false, summary: String(error) })));
        await expect.poll(() => held.length, round).toBe(256);
        await expect(busy.toolCall('firestore_create_document', {
          path: 'limit/refused', data: { message: 'Must not be written' }, as: 'admin',
        })).resolves.toMatchObject({ ok: false, summary: 'resource-exhausted: This client already has 256 pending operations.' });
        expect(excessFrames).toBe(0);
        await expect(busy.toolCall('auth_whoami', {})).resolves.toMatchObject({
          ok: false, summary: 'resource-exhausted: This client already has 256 pending operations.',
        });
        await expect(healthy.toolCall('auth_whoami', {})).resolves.toMatchObject({ ok: true });
        await expect(healthy.toolCall('firestore_get_document', { path: 'limit/refused', as: 'admin' }))
          .resolves.toMatchObject({ ok: true, data: { exists: false } });
        const timesOut = completion === 'timeout' && round === 'first';
        const receivesReplies = !timesOut;
        if (receivesReplies) {
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
      await page.close().finally(() => fixture.stop());
    }
  });
}
