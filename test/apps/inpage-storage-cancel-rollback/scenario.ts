// A page on the in-page sandbox cancels a resumable upload, as a user
// pressing Cancel would, at a range of moments so some land while the commit
// is being written to IndexedDB. Once the task rejects, and from its error
// observer, a read of the path finds no object, or the earlier object when
// the upload was an overwrite: the task settles only once its commit is
// rolled back (#1161).
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Seen {
  rejection: string;
  readAfter: number | string;
  observer: { code: string; read: number | string } | 'completed';
}

/** An upload that completed before its cancel had nothing to roll back. */
function completedFirst(seen: Seen): boolean {
  return seen.rejection === 'resolved';
}

interface CancelApp {
  cancelNew(name: string, size: number, delayMs: number): Promise<Seen>;
  cancelOverwrite(name: string, size: number, delayMs: number): Promise<Seen>;
}
declare const cancelApp: CancelApp;

/** Large enough that writing it to IndexedDB spans several milliseconds. */
const UPLOAD_BYTES = 4 * 1024 * 1024;
const CANCEL_DELAYS_MS = Array.from({ length: 25 }, (_, index) => index);

export default scenario(async (app) => {
  const host = await app.step('start the dev server', () => app.devServer());

  const page = await app.step('open the page on the in-page sandbox', async () => {
    const page = await (await app.browser()).newPage();
    const log = app.browserLog as string[];
    page.on('console', (message) => log.push(`[page console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => log.push(`[page error] ${error.stack ?? error.message}`));
    await page.addInitScript(() => { (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true; });
    await page.goto(host.url);
    await page.waitForFunction(() => 'cancelApp' in window);
    return page;
  });

  await app.step('a canceled upload leaves no object once it rejects, or in its error observer', async () => {
    let canceled = 0;
    for (const delayMs of CANCEL_DELAYS_MS) {
      const seen = await page.evaluate(
        ([name, size, delay]) => cancelApp.cancelNew(name, size, delay),
        [`new-${delayMs}.bin`, UPLOAD_BYTES, delayMs] as const,
      );
      const expected: Seen = {
        rejection: 'storage/canceled',
        readAfter: 'storage/object-not-found',
        observer: { code: 'storage/canceled', read: 'storage/object-not-found' },
      };
      if (completedFirst(seen)) continue;
      canceled++;
      assert.deepEqual(seen, expected, `canceled after ${delayMs} ms: ${JSON.stringify(seen)}`);
    }
    assert.ok(canceled > 0, 'every upload completed before its cancel');
  });

  await app.step('a canceled overwrite leaves the earlier object once it rejects, or in its error observer', async () => {
    let canceled = 0;
    for (const delayMs of CANCEL_DELAYS_MS) {
      const seen = await page.evaluate(
        ([name, size, delay]) => cancelApp.cancelOverwrite(name, size, delay),
        [`overwrite-${delayMs}.bin`, UPLOAD_BYTES, delayMs] as const,
      );
      const expected: Seen = {
        rejection: 'storage/canceled',
        readAfter: 3,
        observer: { code: 'storage/canceled', read: 3 },
      };
      if (completedFirst(seen)) continue;
      canceled++;
      assert.deepEqual(seen, expected, `canceled after ${delayMs} ms: ${JSON.stringify(seen)}`);
    }
    assert.ok(canceled > 0, 'every upload completed before its cancel');
  });
});
