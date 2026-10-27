// DF-1 (#1247): on the Node host, a page's runTransaction that makes a
// data-dependent `.read` false must cancel the listeners that rule guards, as
// a set does, and later data must never reach them.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare const gate: {
  seed(): Promise<void>;
  listen(): void;
  close(): Promise<unknown>;
  writeAfter(): Promise<void>;
  events(): string[];
  markers(): unknown[];
};

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page, seed the gate open, and listen to it', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'gate' in window, undefined, { timeout: 30_000 });
    await page.evaluate(() => gate.seed());
    await page.evaluate(() => gate.listen());
    await page.waitForFunction(() => gate.events().length >= 2, undefined, { timeout: 10_000 });
    return page;
  });

  await app.step('a transaction that closes the gate cancels both gate listeners', async () => {
    await page.evaluate(() => gate.close());
    await page.waitForFunction(
      () => gate.events().filter((event) => event.includes('cancel')).length >= 2,
      undefined,
      { timeout: 10_000 },
    ).catch(() => undefined);
    const events = await page.evaluate(() => gate.events());
    assert.deepEqual([...events].sort(), [
      'added a', 'added cancel PERMISSION_DENIED', 'value cancel PERMISSION_DENIED', 'value {"a":"initial"}',
    ]);
  });

  await app.step('data written after the revocation never reaches the page', async () => {
    await page.evaluate(() => gate.writeAfter());
    await page.waitForFunction(() => gate.markers().includes(1), undefined, { timeout: 10_000 });
    const events = await page.evaluate(() => gate.events());
    assert.ok(!events.some((event) => event.includes('post-revocation') || event === 'added b'), events.join(', '));
  });
});
