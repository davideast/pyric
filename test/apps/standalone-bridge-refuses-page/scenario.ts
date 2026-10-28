// A page can no longer attach to the standalone `pyric bridge` (#1468). The
// app's page, served by its own Vite dev server, calls `connectBridge`
// against `pyric bridge`'s `/sandbox` socket. The bridge closes it before it
// registers, the client stops instead of reconnecting, its error names
// `pyric sandbox --bridge`, and the bridge never reports a connected sandbox.
import assert from 'node:assert/strict';
import { scenario, sleep } from '../driver.ts';

interface BridgeState { kind: string; reason?: string }
declare function attachToBridge(url: string): Promise<{ states: BridgeState[]; final: BridgeState }>;

export default scenario(async (app) => {
  const bridgePort = await app.freePort();
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;

  const bridge = await app.step('pyric bridge starts', async () => {
    const bridge = app.pyricProcess(['bridge', '--port', String(bridgePort)]);
    await bridge.waitForLog(/pyric bridge .* ready/, { timeoutMs: 30_000 });
    return bridge;
  });

  const host = await app.step('start the dev server', () => app.devServer());

  await app.step('connectBridge from the page stops with an error naming pyric sandbox --bridge', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'attachToBridge' in window, undefined, { timeout: 30_000 });
    const result = await page.evaluate((url) => attachToBridge(url), `ws://127.0.0.1:${bridgePort}/sandbox`);
    assert.ok(!result.states.some((state) => state.kind === 'connected'), JSON.stringify(result.states));
    assert.ok(!result.states.some((state) => state.kind === 'reconnecting'), JSON.stringify(result.states));
    assert.equal(result.final.kind, 'disconnected', JSON.stringify(result));
    assert.match(result.final.reason ?? '', /pyric sandbox --bridge/, JSON.stringify(result));
    assert.ok(
      app.browserLog.some((line) => line.includes('console.error') && line.includes('pyric sandbox --bridge')),
      app.browserLog.join('\n'),
    );
  });

  await app.step('pyric bridge never reports a connected sandbox', async () => {
    await sleep(250);
    const health = await (await fetch(`${bridgeUrl}/health`)).json() as { sandboxConnected?: boolean };
    assert.equal(health.sandboxConnected, false, JSON.stringify(health));
    assert.doesNotMatch(bridge.output, /peer connected/, bridge.output);
  });
});
