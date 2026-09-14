import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

const frameLimit = 12 * 1024 * 1024;
for (const frameBytes of [frameLimit - 1, frameLimit, frameLimit + 1]) {
  test(`peer input enforces the ${frameBytes}-byte boundary before dispatch and recovers healthy work`, async ({ page }) => {
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const closed = Promise.withResolvers<number>();
    let sentBytes = 0;
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isTargetCall = isBridgeMessage(frame) && frame.type === 'tool-call' && frame.name === 'firestore_create_document';
        if (isTargetCall) {
          const padded = { ...frame, padding: '' };
          const paddingBytes = frameBytes - Buffer.byteLength(JSON.stringify(padded));
          padded.padding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
          const payload = JSON.stringify(padded);
          sentBytes = Buffer.byteLength(payload);
          route.send(payload);
          return;
        }
        route.send(data);
      });
      route.onClose(async code => {
        await server.close();
        closed.resolve(code);
      });
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await mcp.initialize();
      const result = await mcp.toolCall('firestore_create_document', {
        path: 'shared/refused', data: { message: 'Must not be written' }, as: 'admin',
      });
      expect(sentBytes).toBe(frameBytes);
      const exceedsLimit = frameBytes > frameLimit;
      if (exceedsLimit) {
        expect(result.ok).toBe(false);
        expect(result.summary).not.toContain('timed out');
        expect(await closed.promise).toBe(4009);
      } else {
        expect(result.ok).toBe(true);
      }
      const exists = await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'shared/refused'))).exists();
      });
      expect(exists).toBe(!exceedsLimit);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await waitForPeer(fixture.info.url);
      await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' })).resolves.toMatchObject({
        ok: true, data: { exists: true },
      });
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
