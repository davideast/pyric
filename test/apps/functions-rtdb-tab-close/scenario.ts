// Closing the last browser tab in SharedWorker mode while queued RTDB
// `onValueCreated` deliveries are resolving `sandbox.clock` must report a
// structured delivery error rather than an unhandled rejection, and must keep
// the trigger queue alive when a new tab reconnects (#3326).
import assert from 'node:assert/strict';
import { scenario, sessionHeaders, sleep } from '../driver.ts';

declare function writeBatch(count: number): Promise<void>;
declare function writeSingle(id: string, text: string): Promise<void>;
declare function readUppercase(id: string): Promise<string | null>;

async function sandboxConnected(app: { readonly dir: string }, url: string): Promise<boolean> {
  const response = await fetch(`${url}/__pyric/health`, {
    headers: sessionHeaders(app, url),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { sandboxConnected?: boolean };
  return body.sandboxConnected === true;
}

export default scenario(async (app) => {
  const host = await app.step('start the Vite dev server', () => app.devServer());

  const firstPage = await app.step('open a browser tab so the Functions child starts', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'writeBatch' in window);
    await host.process.waitForLog(/functions 1 onValueCreated trigger/, { timeoutMs: 60_000 });
    return page;
  });

  await app.step('write a batch of RTDB items and close the last tab while deliveries drain', async () => {
    await firstPage.evaluate(() => writeBatch(30));
    await host.process.waitForLog(/function uppercaseItem \u2190 \/items\/item-00\/original/, { timeoutMs: 30_000 });
    await firstPage.close();

    const disconnectDeadline = Date.now() + 15_000;
    while (await sandboxConnected(app, host.url)) {
      assert.ok(Date.now() < disconnectDeadline, 'sandbox stayed connected after closing the last tab');
      await sleep(25);
    }
    // Give the queued deliveries a moment to hit `sandbox.clock` with no tab attached.
    await sleep(150);
  });

  await app.step('a reconnected tab still triggers onValueCreated on subsequent writes', async () => {
    const secondPage = await app.page(host.url);
    await secondPage.waitForFunction(() => 'writeSingle' in window);

    const connectDeadline = Date.now() + 15_000;
    while (!(await sandboxConnected(app, host.url))) {
      assert.ok(Date.now() < connectDeadline, 'sandbox did not reconnect on the second tab');
      await sleep(25);
    }

    await secondPage.evaluate(() => writeSingle('after-reconnect', 'recovered'));

    let uppercase: string | null = null;
    const triggerDeadline = Date.now() + 15_000;
    while (Date.now() < triggerDeadline) {
      uppercase = await secondPage.evaluate(() => readUppercase('after-reconnect'));
      if (uppercase === 'RECOVERED') break;
      await sleep(50);
    }
    assert.equal(uppercase, 'RECOVERED', `trigger queue did not recover:\n${host.process.output}`);
  });
});
