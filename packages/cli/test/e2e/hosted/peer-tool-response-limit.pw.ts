import { readFileSync } from 'node:fs';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

test('an oversized peer tool result refuses the MCP call without disconnecting its consumers', async ({ page }) => {
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
  });
  let closes = 0;
  page.on('websocket', socket => socket.on('close', () => { closes += 1; }));
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    await page.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'large', id), { payload: 'é'.repeat(1024 * 1024) });
      }
    });
    const remote = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await mcp.initialize();
      let outcome: unknown;
      const call = mcp.toolCall('firestore_list_documents', { collection: 'large', as: 'admin' }).then(
        value => { outcome = value; },
        error => { outcome = { error: String(error) }; },
      );
      await expect.poll(() => outcome).toEqual({
        ok: false, summary: 'Bridge response exceeds the 12 MiB encoded frame limit.',
        _pyric: { mode: 'sandbox', project: 'sandbox' },
      });
      await call;
      await remote.channel.op({
        method: 'setDoc', path: 'shared/greeting', data: { message: 'Healthy after tool refusal' }, actAs: { mode: 'admin' },
      });
      await expect(page.locator('#document')).toHaveText('Healthy after tool refusal');
      await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' })).resolves.toMatchObject({
        ok: true, data: { exists: true, data: { message: 'Healthy after tool refusal' } },
      });
      expect(closes).toBe(0);
    } finally {
      remote.close();
    }
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});
