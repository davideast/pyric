import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CLI_PATH, startSoakServe } from '../soak/harness.js';

for (const mode of ['hosted', 'shared-worker', 'in-page'] as const) {
  test(`${mode} capture retains bounded history and CLI refuses incomplete verification`, async ({ page }) => {
    const hosted = mode === 'hosted';
    const inpage = mode === 'in-page';
    const fixture = await startSoakServe({ flags: hosted ? ['--hosted'] : [], extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    } });
    try {
      if (inpage) await page.addInitScript(() => { Reflect.set(globalThis, '__PYRIC_FORCE_INPAGE__', true); });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        const target = sdk.doc(sdk.getFirestore(), 'load', 'capture');
        for (const sequence of Array(48).keys()) {
          await sdk.setDoc(target, { sequence, padding: 'é'.repeat(128 * 1024) });
        }
      });
      const path = join(fixture.dir, '.pyric/last-session.json');
      await expect.poll(() => existsSync(path)).toBe(true);
      const capture = (): { events: Array<{ kind: string; reason?: string }> } => JSON.parse(readFileSync(path, 'utf8'));
      await expect.poll(() => capture().events[0]?.reason).toBe('history-limit');
      expect(Buffer.byteLength(JSON.stringify(capture().events))).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(capture().events.length).toBeLessThanOrEqual(10_001);
      let refusal = '';
      try {
        execFileSync(process.execPath, [CLI_PATH, 'verify', path], { cwd: fixture.dir, encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        const output = error as { stderr: string };
        refusal = output.stderr;
      }
      expect(refusal).toContain('Cannot replay or verify incomplete observation history');
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
